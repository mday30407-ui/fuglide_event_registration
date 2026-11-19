const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createAdminAuth } = require("../src/admin-auth");

const registrationId = "FD26-M-000000000001";

function createMemoryDatabase() {
  const registrations = new Map();
  let transactionTail = Promise.resolve();

  return {
    collection(name) {
      assert.equal(name, "manual_payment_registrations");
      return {
        doc(id) {
          return { id };
        }
      };
    },
    async runTransaction(callback) {
      const previousTransaction = transactionTail;
      let releaseTransaction;
      transactionTail = new Promise((resolve) => {
        releaseTransaction = resolve;
      });
      await previousTransaction;

      try {
        const writes = [];
        const transaction = {
          async get(reference) {
            const value = registrations.get(reference.id);
            return {
              exists: value !== undefined,
              data: () => value && structuredClone(value)
            };
          },
          update(reference, fields) {
            writes.push({ reference, fields: structuredClone(fields) });
          }
        };
        const result = await callback(transaction);
        for (const { reference, fields } of writes) {
          const current = registrations.get(reference.id);
          if (!current) throw new Error("Cannot update a missing registration.");
          registrations.set(reference.id, { ...current, ...fields });
        }
        return result;
      } finally {
        releaseTransaction();
      }
    },
    seed(id, registration) {
      registrations.set(id, structuredClone(registration));
    },
    read(id) {
      const registration = registrations.get(id);
      return registration && structuredClone(registration);
    }
  };
}

function mergeCookies(cookieMap, headers) {
  const values = headers.getSetCookie
    ? headers.getSetCookie()
    : [headers.get("set-cookie") || ""];
  for (const value of values) {
    const cookie = value.split(";")[0];
    const separator = cookie.indexOf("=");
    if (separator > 0) cookieMap.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
}

async function withAdminServer(database, callback) {
  const names = [
    "ADMIN_EMAIL",
    "ADMIN_PASSWORD",
    "ADMIN_PASSWORD_HASH",
    "ADMIN_SESSION_SECRET"
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ADMIN_EMAIL = "admin@example.test";
  process.env.ADMIN_PASSWORD = "test-admin-password";
  process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-value-32";
  delete process.env.ADMIN_PASSWORD_HASH;

  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminAuth({ database }).router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;

  try {
    await callback(address);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function authenticate(address) {
  const cookies = new Map();
  const sessionResponse = await fetch(`${address}/admin/api/session`);
  mergeCookies(cookies, sessionResponse.headers);
  const session = await sessionResponse.json();
  const loginResponse = await fetch(`${address}/admin/api/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      "X-CSRF-Token": session.csrfToken
    },
    body: JSON.stringify({
      email: "admin@example.test",
      password: "test-admin-password"
    })
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  mergeCookies(cookies, loginResponse.headers);
  return {
    cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    csrfToken: login.csrfToken
  };
}

async function submitReviewAction(address, admin, action, body = {}) {
  return fetch(
    `${address}/admin/api/manual/registrations/${registrationId}/${action}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Cookie: admin.cookie,
        "X-CSRF-Token": admin.csrfToken
      },
      body: JSON.stringify(body)
    }
  );
}

test("approves a pending registration with the existing approval fields", async () => {
  const database = createMemoryDatabase();
  database.seed(registrationId, {
    registrationId,
    paymentStatus: "PENDING_VERIFICATION",
    invitationStatus: "NOT_READY",
    rejectionReason: "Previous reason"
  });

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const response = await submitReviewAction(address, admin, "approve");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      paymentStatus: "VERIFIED"
    });

    const registration = database.read(registrationId);
    assert.equal(registration.paymentStatus, "VERIFIED");
    assert.equal(registration.invitationStatus, "READY_TO_SEND");
    assert.equal(registration.rejectionReason, null);
    assert.ok(registration.verifiedAt instanceof Date);
    assert.equal(registration.verifiedBy, "admin@example.test");
  });
});

test("rejects a pending registration with the trimmed rejection reason", async () => {
  const database = createMemoryDatabase();
  database.seed(registrationId, {
    registrationId,
    paymentStatus: "PENDING_VERIFICATION",
    invitationStatus: "NOT_READY"
  });

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const response = await submitReviewAction(address, admin, "reject", {
      rejectionReason: "  Payment could not be verified.  "
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      paymentStatus: "REJECTED"
    });

    const registration = database.read(registrationId);
    assert.equal(registration.paymentStatus, "REJECTED");
    assert.equal(registration.invitationStatus, "NOT_READY");
    assert.equal(registration.rejectionReason, "Payment could not be verified.");
    assert.ok(registration.verifiedAt instanceof Date);
    assert.equal(registration.verifiedBy, "admin@example.test");
  });
});

test("returns conflict without changing an already verified registration", async () => {
  const database = createMemoryDatabase();
  const original = {
    registrationId,
    paymentStatus: "VERIFIED",
    invitationStatus: "READY_TO_SEND",
    rejectionReason: null
  };
  database.seed(registrationId, original);

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const response = await submitReviewAction(address, admin, "approve");
    assert.equal(response.status, 409);
    assert.deepEqual(database.read(registrationId), original);
  });
});

test("returns conflict without changing an already rejected registration", async () => {
  const database = createMemoryDatabase();
  const original = {
    registrationId,
    paymentStatus: "REJECTED",
    invitationStatus: "NOT_READY",
    rejectionReason: "Already reviewed"
  };
  database.seed(registrationId, original);

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const response = await submitReviewAction(address, admin, "reject", {
      rejectionReason: "A new reason"
    });
    assert.equal(response.status, 409);
    assert.deepEqual(database.read(registrationId), original);
  });
});

test("returns 404 for nonexistent registrations in either route", async () => {
  const database = createMemoryDatabase();

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const approval = await submitReviewAction(address, admin, "approve");
    const rejection = await submitReviewAction(address, admin, "reject", {
      rejectionReason: "Not found"
    });
    assert.equal(approval.status, 404);
    assert.equal(rejection.status, 404);
  });
});

test("concurrent approval and rejection requests cannot both succeed", async () => {
  const database = createMemoryDatabase();
  database.seed(registrationId, {
    registrationId,
    paymentStatus: "PENDING_VERIFICATION",
    invitationStatus: "NOT_READY"
  });

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const [approval, rejection] = await Promise.all([
      submitReviewAction(address, admin, "approve"),
      submitReviewAction(address, admin, "reject", { rejectionReason: "Reviewed" })
    ]);

    assert.deepEqual(
      [approval.status, rejection.status].sort(),
      [200, 409]
    );
    const registration = database.read(registrationId);
    assert.ok(["VERIFIED", "REJECTED"].includes(registration.paymentStatus));
    assert.ok(registration.paymentStatus === "VERIFIED"
      ? registration.invitationStatus === "READY_TO_SEND"
      : registration.invitationStatus === "NOT_READY");
  });
});
