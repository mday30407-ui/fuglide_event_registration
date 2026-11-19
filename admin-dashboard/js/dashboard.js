const totalRegistrationsEl = document.getElementById("totalRegistrations");
const paidRegistrationsEl = document.getElementById("paidRegistrations");
const pendingRegistrationsEl = document.getElementById("pendingRegistrations");
const totalRevenueEl = document.getElementById("totalRevenue");
const tableBody = document.getElementById("registrationTableBody");
const userBadge = document.getElementById("userBadge");
const logoutButton = document.getElementById("logoutButton");
const exportButton = document.getElementById("exportButton");
const deleteDialog = document.getElementById("deleteRegistrationDialog");
const deleteParticipantName = document.getElementById("deleteParticipantName");
const deleteRegistrationId = document.getElementById("deleteRegistrationId");
const deleteVerifiedWarning = document.getElementById("deleteVerifiedWarning");
const confirmDeleteButton = document.getElementById("confirmDeleteRegistration");
const cancelDeleteButton = document.getElementById("cancelDeleteRegistration");
let pendingDelete = null;

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
  if (typeof value === "object") {
    const seconds = value._seconds ?? value.seconds;
    if (typeof seconds === "number") {
      return new Date(seconds * 1000).toLocaleString();
    }
    return "-";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function populateRegistrations(registrations) {
  if (!registrations || registrations.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">No registrations yet.</td></tr>';
    return;
  }

  tableBody.innerHTML = registrations.map((registration) => {
    const id = String(registration.id || registration.registrationId || "");
    const status = String(registration.paymentStatus || "PENDING");
    return `
      <tr>
        <td>${escapeHtml(registration.fullName || "-")}</td>
        <td>${escapeHtml(registration.email || "-")}</td>
        <td>${escapeHtml(registration.city || "-")}</td>
        <td>${escapeHtml(registration.participantCategory || registration.category || registration.participationType || "-")}</td>
        <td>${escapeHtml(registration.participationType || "-")}</td>
        <td>${escapeHtml(status)}</td>
        <td>${formatDate(registration.registrationDate || registration.paidAt)}</td>
        <td><button class="delete-registration-button" type="button" data-delete-type="razorpay" data-registration-id="${escapeHtml(id)}" data-registration-name="${escapeHtml(registration.fullName || "-")}" data-payment-status="${escapeHtml(status)}">Delete</button></td>
      </tr>
    `;
  }).join("");
}

function openDeleteDialog(type, id, name, status) {
  pendingDelete = { type, id, name, status };
  deleteParticipantName.textContent = name;
  deleteRegistrationId.textContent = id;
  deleteVerifiedWarning.hidden = status !== "PAID" && status !== "VERIFIED";
  deleteVerifiedWarning.textContent = type === "razorpay"
    ? "This registration has verified payment. Its Razorpay payment/order records will be retained. The same email may not be able to start another registration."
    : "This registration has verified payment. The uploaded screenshot and external payment records will be retained.";
  confirmDeleteButton.disabled = false;
  confirmDeleteButton.textContent = "Confirm Delete";
  deleteDialog.showModal();
}

async function confirmRegistrationDelete() {
  if (!pendingDelete) return;
  const target = pendingDelete;
  confirmDeleteButton.disabled = true;
  confirmDeleteButton.textContent = "Deleting...";
  try {
    const csrfResponse = await fetch("/admin/api/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    const csrfPayload = await csrfResponse.json().catch(() => ({}));
    if (!csrfResponse.ok || !csrfPayload.authenticated) {
      window.location.href = "/admin/login";
      return;
    }

    const endpoint = target.type === "manual"
      ? `/admin/api/manual/registrations/${encodeURIComponent(target.id)}`
      : `/admin/api/registrations/${encodeURIComponent(target.id)}`;
    const response = await fetch(endpoint, {
      method: "DELETE",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrfPayload.csrfToken || ""
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Registration could not be deleted.");

    deleteDialog.close();
    if (target.type === "manual") {
      await Promise.all([loadManualStats(), loadManualRegistrations()]);
    } else {
      await Promise.all([loadStats(), loadRegistrations()]);
    }
  } catch (error) {
    window.alert(error.message);
    confirmDeleteButton.disabled = false;
    confirmDeleteButton.textContent = "Confirm Delete";
  }
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

const participantsTab = document.getElementById("participantsTab");
const manualPaymentsTab = document.getElementById("manualPaymentsTab");
const participantsSection = document.getElementById("participantsSection");
const manualPaymentsSection = document.getElementById("manualPaymentsSection");
const manualTableBody = document.getElementById("manualRegistrationTableBody");
const manualSearch = document.getElementById("manualSearch");
const manualStatusFilter = document.getElementById("manualStatusFilter");
const manualExportButton = document.getElementById("manualExportButton");

function showDashboardSection(section) {
  const manual = section === "manual";
  participantsSection.hidden = manual;
  manualPaymentsSection.hidden = !manual;
  participantsTab.classList.toggle("active", !manual);
  manualPaymentsTab.classList.toggle("active", manual);
  if (manual) {
    loadManualStats();
    loadManualRegistrations();
  }
}

async function loadManualStats() {
  const session = await getSession();
  if (!session) return;
  const response = await fetch("/admin/api/manual/stats", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return;
  document.getElementById("manualTotalRegistrations").textContent = String(payload.totalRegistrations || 0);
  document.getElementById("manualPendingRegistrations").textContent = String(payload.pendingRegistrations || 0);
  document.getElementById("manualVerifiedRegistrations").textContent = String(payload.verifiedRegistrations || 0);
  document.getElementById("manualRejectedRegistrations").textContent = String(payload.rejectedRegistrations || 0);
  document.getElementById("manualVerifiedRevenue").textContent = formatMoney(payload.verifiedRevenue || 0);
}

async function loadManualRegistrations() {
  const session = await getSession();
  if (!session) return;
  const params = new URLSearchParams();
  if (manualSearch.value.trim()) params.set("search", manualSearch.value.trim());
  if (manualStatusFilter.value) params.set("status", manualStatusFilter.value);
  const response = await fetch(`/admin/api/manual/registrations?${params}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return;
  const registrations = payload.registrations || [];
  if (!registrations.length) {
    manualTableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No manual registrations found.</td></tr>';
    return;
  }
  manualTableBody.innerHTML = registrations.map((registration) => {
    const id = escapeHtml(registration.registrationId || registration.id || "");
    return `
      <tr>
        <td>${escapeHtml(registration.fullName || "-")}</td>
        <td>${escapeHtml(registration.email || "-")}</td>
        <td>${escapeHtml(registration.mobile || "-")}</td>
        <td>${escapeHtml(registration.utrNumber || "-")}</td>
        <td><span class="manual-status ${escapeHtml(registration.paymentStatus || "")}">${escapeHtml(registration.paymentStatus || "-")}</span></td>
        <td>${formatDate(registration.submittedAt)}</td>
        <td>
          <div class="manual-row-actions">
            <button class="secondary" type="button" data-manual-details="${id}">View</button>
            <button class="delete-registration-button" type="button" data-delete-type="manual" data-registration-id="${id}" data-registration-name="${escapeHtml(registration.fullName || "-")}" data-payment-status="${escapeHtml(registration.paymentStatus || "")}">Delete</button>
          </div>
        </td>
      </tr>
      <tr class="manual-details-row" id="manual-details-${id}" hidden>
        <td colspan="7">
          <div class="manual-details">
            <dl>
              <div><dt>Registration ID</dt><dd>${id}</dd></div>
              <div><dt>City</dt><dd>${escapeHtml(registration.city || "-")}</dd></div>
              <div><dt>College / Organization</dt><dd>${escapeHtml(registration.college || "-")}</dd></div>
              <div><dt>Participant Category</dt><dd>${escapeHtml(registration.participantCategory || "-")}</dd></div>
              <div><dt>Participation Type</dt><dd>${escapeHtml(registration.participationType || "-")}</dd></div>
              <div><dt>Verified By</dt><dd>${escapeHtml(registration.verifiedBy || "-")}</dd></div>
              <div><dt>Rejection Reason</dt><dd>${escapeHtml(registration.rejectionReason || "-")}</dd></div>
            </dl>
            <div class="manual-screenshot">
              <img src="/admin/api/manual/registrations/${encodeURIComponent(id)}/screenshot" alt="Payment screenshot">
              <input id="manual-reason-${id}" maxlength="500" placeholder="Rejection reason">
              <div class="manual-actions">
                <button class="approve" type="button" data-manual-approve="${id}">Approve payment</button>
                <button class="danger" type="button" data-manual-reject="${id}">Reject payment</button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

async function postManualAction(url, body) {
  const csrfResponse = await fetch("/admin/api/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" }
  });
  const csrfPayload = await csrfResponse.json().catch(() => ({}));
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-CSRF-Token": csrfPayload.csrfToken || ""
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Action could not be completed.");
  return payload;
}

participantsTab.addEventListener("click", () => showDashboardSection("participants"));
manualPaymentsTab.addEventListener("click", () => showDashboardSection("manual"));
tableBody.addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-type]");
  if (button) {
    openDeleteDialog(
      button.dataset.deleteType,
      button.dataset.registrationId,
      button.dataset.registrationName,
      button.dataset.paymentStatus
    );
  }
});
confirmDeleteButton.addEventListener("click", confirmRegistrationDelete);
cancelDeleteButton.addEventListener("click", () => deleteDialog.close());
deleteDialog.addEventListener("close", () => { pendingDelete = null; });
manualSearch.addEventListener("input", loadManualRegistrations);
manualStatusFilter.addEventListener("change", loadManualRegistrations);
manualExportButton.addEventListener("click", () => {
  window.location.href = "/admin/api/manual/export/csv";
});

manualTableBody.addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("[data-delete-type]");
  const detailsId = event.target.dataset.manualDetails;
  const approveId = event.target.dataset.manualApprove;
  const rejectId = event.target.dataset.manualReject;
  if (deleteButton) {
    openDeleteDialog(
      deleteButton.dataset.deleteType,
      deleteButton.dataset.registrationId,
      deleteButton.dataset.registrationName,
      deleteButton.dataset.paymentStatus
    );
  }
  if (detailsId) {
    const details = document.getElementById(`manual-details-${detailsId}`);
    if (details) details.hidden = !details.hidden;
  }
  if (approveId) {
    try {
      await postManualAction(`/admin/api/manual/registrations/${encodeURIComponent(approveId)}/approve`);
      await loadManualStats();
      await loadManualRegistrations();
    } catch (error) {
      window.alert(error.message);
    }
  }
  if (rejectId) {
    const reasonInput = document.getElementById(`manual-reason-${rejectId}`);
    const reason = reasonInput ? reasonInput.value.trim() : "";
    if (!reason) {
      window.alert("A rejection reason is required.");
      return;
    }
    try {
      await postManualAction(
        `/admin/api/manual/registrations/${encodeURIComponent(rejectId)}/reject`,
        { rejectionReason: reason }
      );
      await loadManualStats();
      await loadManualRegistrations();
    } catch (error) {
      window.alert(error.message);
    }
  }
});

(async () => {
  await loadStats();
  await loadRegistrations();
})();
