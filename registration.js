const form = document.getElementById("registration-form");
const fileInput = document.getElementById("payment-screenshot");
const preview = document.getElementById("upload-preview");
const removeButton = document.getElementById("remove-screenshot");
const submitButton = document.getElementById("submit-button");
const errorBox = document.getElementById("form-error");
let submitting = false;

const qr = document.getElementById("payment-qr");
qr.addEventListener("error", () => {
  qr.hidden = true;
  document.getElementById("qr-placeholder").hidden = false;
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!allowed.includes(file.type)) {
    fileInput.value = "";
    return showError("Upload a JPG, PNG, or WebP image.");
  }
  if (file.size > 5 * 1024 * 1024) {
    fileInput.value = "";
    return showError("The payment screenshot must be 5 MB or smaller.");
  }
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
  removeButton.hidden = false;
  hideError();
});

removeButton.addEventListener("click", () => {
  fileInput.value = "";
  preview.removeAttribute("src");
  preview.hidden = true;
  removeButton.hidden = true;
});

form.addEventListener("submit", async (event) => {
  event.preventEvent?.();
  event.preventDefault();
  if (submitting) return;
  hideError();
  if (!form.reportValidity()) return;
  if (!fileInput.files[0]) return showError("Payment screenshot is required.");

  submitting = true;
  submitButton.disabled = true;
  submitButton.textContent = "SUBMITTING...";
  try {
    const response = await fetch("/api/registrations", { method: "POST", body: new FormData(form) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Registration could not be submitted.");
    const statusLink = new URL("./status.html", window.location.href);
    statusLink.hash = new URLSearchParams({
      registrationId: payload.registrationId,
      accessToken: payload.statusAccessToken
    }).toString();
    window.location.replace(statusLink.href);
  } catch (error) {
    showError(error.message);
  } finally {
    submitting = false;
    submitButton.disabled = false;
    submitButton.textContent = "SUBMIT REGISTRATION";
  }
});

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  errorBox.focus();
}
function hideError() { errorBox.hidden = true; }
