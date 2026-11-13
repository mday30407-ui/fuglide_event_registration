const form = document.querySelector("#registration-form");
const submitButton = document.querySelector("#submit-button");
const formError = document.querySelector("#form-error");
const registrationPanel = document.querySelector("#registration-panel");
const confirmation = document.querySelector("#confirmation");
const whatsappRecipient = "919150792336";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.hidden = true;
  if (!form.reportValidity()) return;

  const registration = Object.fromEntries(new FormData(form).entries());
  if (!openWhatsApp(registration)) return;

  setBusy(true);
  try {
    const result = await postJson("/api/registrations", registration);
    showConfirmation(result.registration);
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
    "Payment status: UNPAID (online payment temporarily unavailable)",
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
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed. Please try again.");
  return result;
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "Submitting registration…" : "Submit Registration";
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