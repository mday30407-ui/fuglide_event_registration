const form = document.getElementById("status-form");
const errorBox = document.getElementById("status-error");
const submitButton = document.getElementById("status-submit");
let statusCredentials = null;
let checking = false;

const fragment = new URLSearchParams(window.location.hash.slice(1));
const linkedRegistrationId = fragment.get("registrationId");
const linkedAccessToken = fragment.get("accessToken");
if (linkedRegistrationId && linkedAccessToken) {
  document.getElementById("status-registration-id").value = linkedRegistrationId;
  document.getElementById("status-access-token").value = linkedAccessToken;
  statusCredentials = { registrationId: linkedRegistrationId, accessToken: linkedAccessToken };
  form.hidden = true;
  document.getElementById("status-loading").hidden = false;
  checkStatus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  statusCredentials = {
    registrationId: document.getElementById("status-registration-id").value.trim(),
    accessToken: document.getElementById("status-access-token").value.trim()
  };
  checkStatus();
});

document.getElementById("refresh-status").addEventListener("click", checkStatus);

async function checkStatus() {
  if (checking || !statusCredentials) return;
  checking = true;
  submitButton.disabled = true;
  errorBox.hidden = true;
  try {
    const response = await fetch("/api/registration-status", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      cache: "no-store",
      body: JSON.stringify(statusCredentials)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to check registration status.");

    const messages = {
      PENDING_VERIFICATION: "Payment pending verification",
      VERIFIED: "Payment verified",
      REJECTED: "Payment verification rejected"
    };
    document.getElementById("status-heading").textContent =
      messages[payload.paymentStatus] || "Registration status";
    document.getElementById("status-result-id").textContent = payload.registrationId || "-";
    document.getElementById("status-result-name").textContent = payload.fullName || "-";
    document.getElementById("status-result-payment").textContent = payload.paymentStatus || "-";
    document.getElementById("status-result-submitted").textContent = formatDate(payload.submittedAt);
    document.getElementById("status-result-verified").textContent = formatDate(payload.verifiedAt);
    document.getElementById("status-result-invitation").textContent = payload.invitationStatus || "-";
    const reason = document.getElementById("status-rejection-reason");
    reason.textContent = payload.rejectionReason ? `Reason: ${payload.rejectionReason}` : "";
    reason.hidden = !payload.rejectionReason;
    document.getElementById("invitation-note").hidden = payload.invitationStatus !== "READY_TO_SEND";
    document.getElementById("status-result").hidden = false;
    form.hidden = true;
    document.getElementById("status-loading").hidden = true;
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    form.hidden = false;
    document.getElementById("status-loading").hidden = true;
  } finally {
    checking = false;
    submitButton.disabled = false;
  }
}

function formatDate(value) {
  if (!value) return "Not yet verified";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}
