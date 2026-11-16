const form = document.getElementById("loginForm");
const statusBox = document.getElementById("status");

async function getCsrfToken() {
  const response = await fetch("/admin/api/session", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const payload = await response.json();
  return payload.csrfToken || "";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const csrfToken = await getCsrfToken();

  statusBox.textContent = "Signing in...";

  const response = await fetch("/admin/api/login", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ email, password })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    statusBox.textContent = payload.error || "Unable to sign in.";
    return;
  }

  window.location.href = "/admin";
});
