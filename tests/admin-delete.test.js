const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");

const razorpayId = "FD26-00000000-0000-4000-8000-000000000001";
const manualId = "FD26-M-000000000001";

function createMemoryDatabase() {
  const collections = new Map();
  let generatedId = 0;
  let transactionFailure = false;
  const getCollection = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const createRef = (collectionName, id) => ({
    collectionName,
    id,
    get() {
      const value = getCollection(collectionName).get(id);
      return Promise.resolve({
        exists: value !== undefined,
        data: () => value && structuredClone(value)
      });
    }
  });
  const database = {
    collection(name) {
      return {
        doc(id) {
          return createRef(name, id || `generated-${++generatedId}`);
        },
        where(field, operator, value) {
          return { collectionName: name, field, operator, value, isQuery: true };
        }
      };
    },
    async runTransaction(callback) {
      if (transactionFailure) throw new Error("Injected transaction failure.");
      const writes = [];
      const transaction = {
        async get(target) {
          if (target.isQuery) {
            const docs = [];
            for (const [id, data] of getCollection(target.collectionName)) {
              if (target.operator === "==" && data[target.field] === target.value) {
                docs.push({
                  ref: createRef(target.collectionName, id),
                  data: () => structuredClone(data)
                });
              }
            }
            return { docs };
          }
          const value = getCollection(target.collectionName).get(target.id);
          return {
            exists: value !== undefined,
            data: () => value && structuredClone(value)
          };
        },
        delete(ref) {
          writes.push({ type: "delete", ref });
        },
        create(ref, data) {
          writes.push({ type: "create", ref, data: structuredClone(data) });
        }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const collection = getCollection(write.ref.collectionName);
        if (write.type === "create" && collection.has(write.ref.id)) {
          throw new Error("Document already exists.");
        }
      }
      for (const write of writes) {
        const collection = getCollection(write.ref.collectionName);
        if (write.type === "delete") collection.delete(write.ref.id);
        else collection.set(write.ref.id, write.data);
      }
      return result;
    },
    seed(name, id, value) {
      getCollection(name).set(id, structuredClone(value));
    },
    entries(name) {
      return [...getCollection(name).entries()];
    },
    has(name, id) {
      return getCollection(name).has(id);
    },
    failTransactions() {
      transactionFailure = true;
    }
  };
  return database;
}

function setAdminEnvironment() {
  const names = ["ADMIN_EMAIL", "ADMIN_PASSWORD", "ADMIN_PASSWORD_HASH", "ADMIN_SESSION_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ADMIN_EMAIL = "admin@example.test";
  process.env.ADMIN_PASSWORD = "test-admin-password";
  delete process.env.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-value-32";
  return () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
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

async function withAdminServer(database, callback, appOptions = {}) {
  const restoreEnvironment = setAdminEnvironment();
  const server = createApp({ database, ...appOptions }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(address);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    restoreEnvironment();
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
    body: JSON.stringify({ email: "admin@example.test", password: "test-admin-password" })
  });
  assert.equal(loginResponse.status, 200);
  mergeCookies(cookies, loginResponse.headers);
  return {
    cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    csrfToken: cookies.get("admin_csrf")
  };
}

test("registration deletes require admin auth and valid CSRF, then remove only the target record and audit it", async () => {
  const database = createMemoryDatabase();
  database.seed("event_registrations", razorpayId, {
    registrationId: razorpayId,
    fullName: "Paid Participant",
    paymentStatus: "PAID",
    razorpayPaymentId: "payment-retained"
  });
  database.seed("payment_attempts", "payment-lock", { registrationId: razorpayId, status: "paid" });
  database.seed("payment_orders", "order-retained", { registrationId: razorpayId });

  await withAdminServer(database, async (address) => {
    const endpoint = `${address}/admin/api/registrations/${razorpayId}`;
    const unauthenticated = await fetch(endpoint, {
      method: "DELETE",
      headers: { Accept: "application/json" }
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(database.has("event_registrations", razorpayId), true);

    const admin = await authenticate(address);
    const csrfRejected = await fetch(endpoint, {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Cookie: `${admin.cookie}; admin_csrf=wrong`,
        "X-CSRF-Token": admin.csrfToken
      }
    });
    assert.equal(csrfRejected.status, 403);
    assert.equal(database.has("event_registrations", razorpayId), true);

    const response = await fetch(endpoint, {
      method: "DELETE",
      headers: { Accept: "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrfToken }
    });
    assert.equal(response.status, 200);
    assert.equal(database.has("event_registrations", razorpayId), false);
    assert.equal(database.has("payment_attempts", "payment-lock"), true);
    assert.equal(database.has("payment_orders", "order-retained"), true);
    const [audit] = database.entries("admin_audit_logs");
    assert.equal(audit[1].registrationId, razorpayId);
    assert.equal(audit[1].adminEmail, "admin@example.test");
    assert.equal(audit[1].paymentStatus, "PAID");
  });
});

test("registration delete rejects malformed and nonexistent IDs", async () => {
  const database = createMemoryDatabase();
  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    for (const [id, expectedStatus] of [
      ["not-a-registration", 400],
      ["FD26-00000000-0000-4000-8000-000000000099", 404]
    ]) {
      const response = await fetch(`${address}/admin/api/registrations/${id}`, {
        method: "DELETE",
        headers: { Accept: "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrfToken }
      });
      assert.equal(response.status, expectedStatus);
    }
    assert.equal(database.entries("admin_audit_logs").length, 0);
  });
});

test("registration delete leaves the record intact when Firestore transaction fails", async () => {
  const database = createMemoryDatabase();
  database.seed("event_registrations", razorpayId, {
    registrationId: razorpayId,
    fullName: "Still Registered",
    paymentStatus: "PAID"
  });
  database.failTransactions();

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const response = await fetch(`${address}/admin/api/registrations/${razorpayId}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrfToken }
    });
    assert.equal(response.status, 503);
    assert.equal(database.has("event_registrations", razorpayId), true);
    assert.equal(database.entries("admin_audit_logs").length, 0);
  });
});

test("manual registration delete removes only its matching duplicate lock", async () => {
  const database = createMemoryDatabase();
  let screenshotDeleteCalls = 0;
  database.seed("manual_payment_registrations", manualId, {
    registrationId: manualId,
    fullName: "Verified Participant",
    paymentStatus: "VERIFIED",
    paymentScreenshotStoragePath:
      `manual-payment-screenshots/${manualId}/00000000-0000-4000-8000-000000000001.png`
  });
  database.seed("manual_payment_duplicate_locks", "matching-lock", {
    registrationId: manualId,
    email: "person@example.test",
    utrNumber: "ABC123456"
  });
  database.seed("manual_payment_duplicate_locks", "unrelated-lock", {
    registrationId: "FD26-M-FFFFFFFFFFFF",
    email: "other@example.test",
    utrNumber: "XYZ123456"
  });

  await withAdminServer(database, async (address) => {
    const admin = await authenticate(address);
    const response = await fetch(`${address}/admin/api/manual/registrations/${manualId}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Cookie: admin.cookie, "X-CSRF-Token": admin.csrfToken }
    });
    assert.equal(response.status, 200);
    assert.equal(database.has("manual_payment_registrations", manualId), false);
    assert.equal(database.has("manual_payment_duplicate_locks", "matching-lock"), false);
    assert.equal(database.has("manual_payment_duplicate_locks", "unrelated-lock"), true);
    const [audit] = database.entries("admin_audit_logs");
    assert.equal(audit[1].registrationType, "manual");
    assert.equal(audit[1].paymentStatus, "VERIFIED");
    assert.equal(screenshotDeleteCalls, 0);
  }, {
    manualStorage: {
      async deleteScreenshot() {
        screenshotDeleteCalls += 1;
      }
    }
  });
});
