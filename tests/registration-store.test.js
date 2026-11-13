const test = require("node:test");
const assert = require("node:assert/strict");
const { createRegistrationStore } = require("../src/registration-store");
const { validateRegistration } = require("../src/registration-validation");

function createMemoryDatabase() {
  const documents = new Map();
  const reference = (collection, id) => ({ key: `${collection}/${id}` });

  return {
    documents,
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

test("stores an unpaid registration once and rejects changed duplicate details", async () => {
  const previousSecret = process.env.REGISTRATION_LOCK_SECRET;
  process.env.REGISTRATION_LOCK_SECRET = "test-registration-lock-secret";
  try {
    const database = createMemoryDatabase();
    const store = createRegistrationStore(database);
    const first = await store.submitRegistration(registration);
    const duplicate = await store.submitRegistration(registration);
    const saved = database.documents.get(`event_registrations/${first.registrationId}`);

    assert.equal(first.paymentStatus, "UNPAID");
    assert.equal(first.registrationFee, 250);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.registrationId, first.registrationId);
    assert.equal(saved.currency, "INR");
    assert.equal(saved.razorpayOrderId, null);
    assert.equal(saved.razorpayPaymentId, null);
    assert.equal(saved.paidAt, null);
    assert.equal([...database.documents.keys()].filter((key) => key.startsWith("event_registrations/")).length, 1);
    await assert.rejects(
      store.submitRegistration({ ...registration, participationType: "Sponsor" }),
      { statusCode: 409 }
    );
  } finally {
    if (previousSecret === undefined) delete process.env.REGISTRATION_LOCK_SECRET;
    else process.env.REGISTRATION_LOCK_SECRET = previousSecret;
  }
});
