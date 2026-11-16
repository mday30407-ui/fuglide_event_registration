const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createRegistrationStore } = require("../src/registration-store");
const { validateRegistration } = require("../src/registration-validation");

function createMemoryDatabase() {
  const documents = new Map();
  let nextTransactionError;
  const reference = (collection, id) => ({
    id,
    key: `${collection}/${id}`,
    async get() {
      const value = documents.get(`${collection}/${id}`);
      return { exists: value !== undefined, data: () => value };
    }
  });

  return {
    documents,
    failNextTransaction(error) {
      nextTransactionError = error;
    },
    collection(name) {
      return { doc: (id) => reference(name, id) };
    },
    async runTransaction(work) {
      const writes = [];
      const transaction = {
        async get(ref) {
          const value = documents.get(ref.key);
          return { exists: value !== undefined, data: () => value };
        },
        create(ref, value) {
          writes.push({ kind: "create", ref, value });
        },
        set(ref, value) {
          writes.push({ kind: "set", ref, value });
        }
      };
      const result = await work(transaction);
      if (nextTransactionError) {
        const error = nextTransactionError;
        nextTransactionError = undefined;
        throw error;
      }
      for (const write of writes) {
        if (write.kind === "create" && documents.has(write.ref.key)) {
          throw new Error("Document already exists.");
        }
        documents.set(write.ref.key, write.value);
      }
      return result;
    }
  };
}

const registration = validateRegistration({
  fullName: "Asha Rao",
  email: "asha@example.com",
  mobile: "+91 9876543210",
  gender: "",
  city: "Pune",
  organization: "Example College",
  designation: "Student",
  participantCategory: "College / University Student",
  participationType: "Event Attendee",
  message: ""
});

test("requires a stable registration lock secret", () => {
  const previousSecret = process.env.REGISTRATION_LOCK_SECRET;
  delete process.env.REGISTRATION_LOCK_SECRET;
  try {
    assert.throws(() => createRegistrationStore({}), (error) => {
      assert.match(error.message, /REGISTRATION_LOCK_SECRET must be configured/);
      assert.equal(error.firebaseInitializationClassification, "REGISTRATION_LOCK_SECRET_MISSING");
      return true;
    });
  } finally {
    if (previousSecret === undefined) delete process.env.REGISTRATION_LOCK_SECRET;
    else process.env.REGISTRATION_LOCK_SECRET = previousSecret;
  }
});

function registrationDigest(value, secret) {
  return createHmac("sha256", secret)
    .update(JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]])))
    .digest("hex");
}

test("stores a registration once after payment verification", async () => {
  const previousSecret = process.env.REGISTRATION_LOCK_SECRET;
  process.env.REGISTRATION_LOCK_SECRET = "test-registration-lock-secret";
  try {
    const database = createMemoryDatabase();
    const store = createRegistrationStore(database);
    const emailLock = createHmac("sha256", process.env.REGISTRATION_LOCK_SECRET)
      .update(registration.email)
      .digest("hex");
    const requestDigest = registrationDigest(registration, process.env.REGISTRATION_LOCK_SECRET);
    database.documents.set(`payment_attempts/${emailLock}`, {
      status: "open",
      orderId: "order_test",
      requestDigest
    });

    const first = await store.completeRegistration(registration, "order_test", "pay_test");
    const duplicate = await store.completeRegistration(registration, "order_test", "pay_test");
    const saved = database.documents.get(`event_registrations/${first.registrationId}`);

    assert.equal(first.paymentStatus, "PAID");
    assert.equal(first.amountPaid, 250);
    assert.equal(duplicate.registrationId, first.registrationId);
    assert.equal(saved.currency, "INR");
    assert.equal(saved.razorpayOrderId, "order_test");
    assert.equal(saved.razorpayPaymentId, "pay_test");
    assert.ok(saved.paidAt);
    assert.equal([...database.documents.keys()].filter((key) => key.startsWith("event_registrations/")).length, 1);
    await assert.rejects(
      store.completeRegistration(registration, "order_test", "another_payment"),
      { statusCode: 409 }
    );
  } finally {
    if (previousSecret === undefined) delete process.env.REGISTRATION_LOCK_SECRET;
    else process.env.REGISTRATION_LOCK_SECRET = previousSecret;
  }
});

test("recovers captured orders from webhooks without duplicating registrations", async () => {
  const previousSecret = process.env.REGISTRATION_LOCK_SECRET;
  process.env.REGISTRATION_LOCK_SECRET = "test-registration-lock-secret";
  try {
    const database = createMemoryDatabase();
    const store = createRegistrationStore(database);
    await store.createOrder(registration, async () => ({ id: "order_webhook" }));
    const attemptEntry = [...database.documents.entries()]
      .find(([key]) => key.startsWith("payment_attempts/"));
    const savedAttempt = attemptEntry[1];
    savedAttempt.registration = Object.fromEntries(
      Object.entries(savedAttempt.registration).reverse()
    );

    const first = await store.completeRegistrationForOrder(
      "order_webhook",
      "pay_webhook",
      "event_webhook"
    );
    const duplicate = await store.completeRegistrationForOrder(
      "order_webhook",
      "pay_webhook",
      "event_webhook"
    );
    const secondEvent = await store.completeRegistrationForOrder(
      "order_webhook",
      "pay_webhook",
      "event_webhook_retry"
    );
    const completedAttempt = database.documents.get(attemptEntry[0]);

    assert.equal(first.duplicate, false);
    assert.equal(first.registration.paymentStatus, "PAID");
    assert.equal(duplicate.duplicate, true);
    assert.equal(secondEvent.duplicate, false);
    assert.equal(secondEvent.registration.registrationId, first.registration.registrationId);
    assert.equal(await store.hasWebhookEvent("event_webhook"), true);
    assert.equal(completedAttempt.registration, undefined);
    assert.equal([...database.documents.keys()].filter((key) => key.startsWith("event_registrations/")).length, 1);
    assert.equal([...database.documents.keys()].filter((key) => key.startsWith("webhook_events/")).length, 2);
  } finally {
    if (previousSecret === undefined) delete process.env.REGISTRATION_LOCK_SECRET;
    else process.env.REGISTRATION_LOCK_SECRET = previousSecret;
  }
});

test("does not partially register a payment when the Firestore transaction fails", async () => {
  const previousSecret = process.env.REGISTRATION_LOCK_SECRET;
  process.env.REGISTRATION_LOCK_SECRET = "test-registration-lock-secret";
  try {
    const database = createMemoryDatabase();
    const store = createRegistrationStore(database);
    await store.createOrder(registration, async () => ({ id: "order_transaction_failure" }));
    database.failNextTransaction(new Error("Simulated Firestore transaction failure."));

    await assert.rejects(
      store.completeRegistrationForOrder(
        "order_transaction_failure",
        "pay_transaction_failure",
        "event_transaction_failure"
      ),
      /Simulated Firestore transaction failure/
    );
    assert.equal([...database.documents.keys()].filter((key) => key.startsWith("event_registrations/")).length, 0);
    assert.equal(await store.hasWebhookEvent("event_transaction_failure"), false);
  } finally {
    if (previousSecret === undefined) delete process.env.REGISTRATION_LOCK_SECRET;
    else process.env.REGISTRATION_LOCK_SECRET = previousSecret;
  }
});

test("records failed webhook deliveries idempotently without blocking payment retry", async () => {
  const previousSecret = process.env.REGISTRATION_LOCK_SECRET;
  process.env.REGISTRATION_LOCK_SECRET = "test-registration-lock-secret";
  try {
    const database = createMemoryDatabase();
    const store = createRegistrationStore(database);
    await store.createOrder(registration, async () => ({ id: "order_failed" }));

    assert.equal(await store.recordFailedPayment("order_failed", "pay_failed", "event_failed"), true);
    assert.equal(await store.recordFailedPayment("order_failed", "pay_failed", "event_failed"), false);
    const retry = await store.createOrder(registration, async () => {
      throw new Error("An open order should be reused.");
    });

    assert.deepEqual(retry, { orderId: "order_failed" });
    const attempt = [...database.documents.entries()]
      .find(([key]) => key.startsWith("payment_attempts/"))[1];
    assert.equal(attempt.status, "open");
    assert.equal(attempt.lastFailurePaymentId, "pay_failed");
  } finally {
    if (previousSecret === undefined) delete process.env.REGISTRATION_LOCK_SECRET;
    else process.env.REGISTRATION_LOCK_SECRET = previousSecret;
  }
});
