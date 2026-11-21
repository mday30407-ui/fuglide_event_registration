const form = document.getElementById("registration-form");
const fileInput = document.getElementById("payment-screenshot");
const preview = document.getElementById("upload-preview");
const removeButton = document.getElementById("remove-screenshot");
const submitButton = document.getElementById("submit-button");
const errorBox = document.getElementById("form-error");
let submitting = false;

const upiPayButton = document.getElementById("upi-pay-button");
const upiPayStatus = document.getElementById("upi-pay-status");
const copyUpiButton = document.getElementById("copy-upi-id");
const upiId = document.getElementById("upi-id");

const upiIdValue = upiId ? upiId.textContent.trim() : "";
if (upiPayButton && upiIdValue) {
  upiPayButton.addEventListener("click", () => {
    const payeeName = encodeURIComponent("Vinoow Kuttyma").replace(/%20/g, "%20");
    const upiUri = `upi://pay?pa=${upiIdValue}&pn=${payeeName}&am=100.00&cu=INR&aid=uGICAgKCLyIKISg`;
    upiPayStatus.textContent = "Opening a UPI app. If no app opens, use the QR code or copy the UPI ID.";
    window.location.assign(upiUri);
  });
} else if (upiPayButton) {
  upiPayButton.disabled = true;
}

if (copyUpiButton && upiId) {
  copyUpiButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(upiId.textContent.trim());
      upiPayStatus.textContent = "UPI ID copied successfully.";
    } catch {
      const selection = window.getSelection();
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(upiId);
      selection.addRange(range);
      upiPayStatus.textContent = `Copy this UPI ID manually: ${upiId.textContent.trim()}`;
    }
  });
}

const qr = document.getElementById("payment-qr");
qr?.addEventListener("error", () => {
  qr.hidden = true;
  document.getElementById("qr-placeholder").hidden = false;
});

const qrShareButton = document.getElementById("share-qr-button");
const qrShareStatus = document.getElementById("qr-share-status");
let qrShareFile = null;
let qrShareFileUnavailable = false;

function getQrFallbackUrl() {
  if (qrShareFile) return URL.createObjectURL(qrShareFile);
  if (qr) return qr.currentSrc || qr.src;
  return null;
}

function downloadQrImage() {
  const url = getQrFallbackUrl();
  if (!url) {
    qrShareStatus.textContent = "The QR image could not be opened.";
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = "payment-qr.jpeg";
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  if (qrShareFile) {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  qrShareStatus.textContent = "QR image download started. Save or share it from Downloads.";
}

if (qrShareButton) {
  qrShareButton.disabled = true;
  if (qr) {
    fetch(qr.currentSrc || qr.src)
      .then((response) => {
        if (!response.ok) throw new Error("The QR image could not be loaded.");
        return response.blob();
      })
      .then((blob) => new File([blob], "payment-qr.jpeg", { type: "image/jpeg" }))
      .then((file) => {
        qrShareFile = file;
      }, () => {
        qrShareFileUnavailable = true;
      })
      .finally(() => {
        qrShareButton.disabled = false;
      });
  } else {
    qrShareFileUnavailable = true;
    qrShareButton.disabled = false;
  }
}

if (qrShareButton && qrShareStatus) {
  qrShareButton.addEventListener("click", async () => {
    qrShareStatus.textContent = "";
    if (typeof navigator.share !== "function") {
      downloadQrImage();
      return;
    }

    if (!qrShareFile) {
      qrShareStatus.textContent = qrShareFileUnavailable
        ? "The QR image could not be prepared for sharing."
        : "The QR image is still being prepared. Please try again in a moment.";
      return;
    }

    const files = [qrShareFile];
    const qrUrl = new URL(qr.currentSrc || qr.src, window.location.href).href;
    try {
      if (typeof navigator.canShare === "function" &&
          !navigator.canShare({ files })) {
        await navigator.share({
          title: "Founder’s Diary 2026 UPI QR code",
          text: "Founder’s Diary 2026 - UPI payment QR",
          url: qrUrl
        });
        return;
      }
      await navigator.share({ files, title: "Founder’s Diary 2026 UPI QR code" });
    } catch (error) {
      if (error && error.name === "AbortError") return;

      try {
        await navigator.share({
          title: "Founder’s Diary 2026 UPI QR code",
          text: "Founder’s Diary 2026 - UPI payment QR",
          url: qrUrl
        });
      } catch (fallbackError) {
        if (!fallbackError || fallbackError.name !== "AbortError") {
          downloadQrImage();
        }
      }
    }
  });
}

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
    const statusLink = new URL("/status.html", window.location.origin);
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
