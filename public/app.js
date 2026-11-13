const form = document.querySelector("#registration-form");
const payButton = document.querySelector("#pay-button");
const formError = document.querySelector("#form-error");
const registrationPanel = document.querySelector("#registration-panel");
const confirmation = document.querySelector("#confirmation");
const whatsappRecipient = "9629255773";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.hidden = true;
  if (!form.reportValidity()) return;

  const registration = Object.fromEntries(new FormData(form).entries());
  if (!openWhatsApp(registration)) return;

  if (!window.Razorpay) {
    showError("Payment checkout could not be loaded. Check your connection and try again.");
    return;
  }

  setBusy(true, "Preparing secure payment…");
  try {
    const order = await postJson("/api/orders", registration);
    if (order.completed) {
      showConfirmation(order.registration);
      return;
    }

    const checkout = new Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: "FU-GLIDE",
      description: "FOUNDER'S DIARY 2026 Registration",
      order_id: order.orderId,
      prefill: { name: order.name, email: order.email, contact: order.mobile },
      theme: { color: "#e8b650" },
      handler: async (payment) => {
        setBusy(true, "Verifying payment…");
        try {
          const result = await postJson("/api/verify", {
            ...registration,
            razorpay_order_id: payment.razorpay_order_id,
            razorpay_payment_id: payment.razorpay_payment_id,
            razorpay_signature: payment.razorpay_signature
          });
          showConfirmation(result.registration);
        } catch (error) {
          showError(error.message);
          setBusy(false);
        }
      },
      modal: { ondismiss: () => setBusy(false) }
    });
    checkout.on("payment.failed", (payment) => {
      showError(payment.error && payment.error.description || "Payment failed. You can try again.");
      setBusy(false);
    });
    checkout.open();
  } catch (error) {
    showError(error.message);
    setBusy(false);
  }
});

document.querySelector("#print-button").addEventListener("click", () => window.print());

function openWhatsApp(registration) {
  const fields = [
    ["Full Name", registration.fullName],
    ["Email Address", registration.email],
    ["Mobile Number", registration.mobile],
    ["Gender", registration.gender || "Not provided"],
    ["City", registration.city],
    ["College / Organization Name", registration.organization],
    ["Designation / Course", registration.designation],
    ["Participant Category", registration.participantCategory],
    ["Participation Type", registration.participationType],
    ["Additional Message", registration.message || "Not provided"]
  ];
  const message = [
    "FOUNDER'S DIARY 2026 registration details",
    "Payment status: Not yet confirmed",
    ...fields.map(([label, value]) => `${label}: ${value}`)
  ].join("\n");
  const url = `https://wa.me/${whatsappRecipient}?text=${encodeURIComponent(message)}`;
  const whatsappWindow = window.open(url, "_blank");
  if (!whatsappWindow) {
    showError("Your browser blocked WhatsApp. Allow pop-ups, then try again.");
    return false;
  }
  whatsappWindow.opener = null;
  return true;
}

async function postJson(url, payload) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach the registration server. Run npm start and open http://localhost:3000.");
    }
    throw error;
  }

  if (!(response.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
    throw new Error("This page is not connected to the registration API. Run npm start and open http://localhost:3000.");
  }

  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed. Please try again.");
  return result;
}

function setBusy(isBusy, label = "Proceed to Payment – ₹250") {
  payButton.disabled = isBusy;
  payButton.textContent = isBusy ? label : "Proceed to Payment – ₹250";
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
  formError.focus();
}

function showConfirmation(registration) {
  document.querySelector("#confirmation-id").textContent = registration.registrationId;
  document.querySelector("#confirmation-name").textContent = registration.fullName;
  document.querySelector("#confirmation-status").textContent = registration.paymentStatus;
  registrationPanel.hidden = true;
  confirmation.hidden = false;
  confirmation.focus();
}