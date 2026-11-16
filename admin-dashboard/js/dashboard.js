const totalRegistrationsEl = document.getElementById("totalRegistrations");
const paidRegistrationsEl = document.getElementById("paidRegistrations");
const pendingRegistrationsEl = document.getElementById("pendingRegistrations");
const totalRevenueEl = document.getElementById("totalRevenue");
const tableBody = document.getElementById("registrationTableBody");
const userBadge = document.getElementById("userBadge");
const logoutButton = document.getElementById("logoutButton");
const exportButton = document.getElementById("exportButton");

async function getSession() {
  const response = await fetch("/admin/api/session", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.authenticated) {
    window.location.href = "/admin/login";
    return null;
  }

  userBadge.textContent = payload.user.email;
  return payload;
}

function formatMoney(value) {
  return `₹${Number(value || 0).toLocaleString("en-IN")}`;
}

function formatDate(value) {
  if (!value) return "-";
  if (typeof value.toDate === "function") return value.toDate().toLocaleString();
  return new Date(value).toLocaleString();
}

function populateRegistrations(registrations) {
  if (!registrations || registrations.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No registrations yet.</td></tr>';
    return;
  }

  tableBody.innerHTML = registrations.map((registration) => `
    <tr>
      <td>${registration.fullName || "-"}</td>
      <td>${registration.email || "-"}</td>
      <td>${registration.city || "-"}</td>
      <td>${registration.participantCategory || registration.category || registration.participationType || "-"}</td>
      <td>${registration.paymentStatus || "PENDING"}</td>
      <td>${formatDate(registration.registrationDate || registration.paidAt)}</td>
    </tr>
  `).join("");
}

async function loadStats() {
  const session = await getSession();
  if (!session) return;

  const response = await fetch("/admin/api/stats", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    window.location.href = "/admin/login";
    return;
  }

  totalRegistrationsEl.textContent = String(payload.totalRegistrations || 0);
  paidRegistrationsEl.textContent = String(payload.paidRegistrations || 0);
  pendingRegistrationsEl.textContent = String(payload.pendingRegistrations || 0);
  totalRevenueEl.textContent = formatMoney(payload.totalRevenue || 0);
}

async function loadRegistrations() {
  const session = await getSession();
  if (!session) return;

  const response = await fetch("/admin/api/registrations", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    window.location.href = "/admin/login";
    return;
  }

  populateRegistrations(payload.registrations || []);
}

async function logout() {
  const session = await getSession();
  if (!session) return;

  const csrfResponse = await fetch("/admin/api/session", {
    method: "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const csrfPayload = await csrfResponse.json().catch(() => ({}));

  await fetch("/admin/api/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "X-CSRF-Token": csrfPayload.csrfToken || ""
    }
  });

  window.location.href = "/admin/login";
}

exportButton.addEventListener("click", async () => {
  const session = await getSession();
  if (!session) return;
  window.location.href = "/admin/api/export/csv";
});

logoutButton.addEventListener("click", logout);

(async () => {
  await loadStats();
  await loadRegistrations();
})();
