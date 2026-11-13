const { createHmac, randomUUID } = require("node:crypto");
const { FieldValue } = require("firebase-admin/firestore");
const { REGISTRATION_FEE } = require("./registration-validation");

function createRegistrationStore(database) {
  const secret = process.env.REGISTRATION_LOCK_SECRET;
  if (!secret) throw new Error("REGISTRATION_LOCK_SECRET must be configured.");

  const emailLockId = (email) => createHmac("sha256", secret)
    .update(email.trim().toLowerCase())
    .digest("hex");

  return {
    async submitRegistration(registration) {
      const lockRef = database.collection("registration_submissions").doc(emailLockId(registration.email));
      const paymentAttemptRef = database.collection("payment_attempts").doc(emailLockId(registration.email));
      const requestDigest = createHmac("sha256", secret)
        .update(JSON.stringify(registration))
        .digest("hex");
      const registrationId = `FD26-${randomUUID().toUpperCase()}`;
      const registrationRef = database.collection("event_registrations").doc(registrationId);

      return database.runTransaction(async (transaction) => {
        const lockSnapshot = await transaction.get(lockRef);
        const paymentAttemptSnapshot = await transaction.get(paymentAttemptRef);
        if (paymentAttemptSnapshot.exists && paymentAttemptSnapshot.data().status === "paid") {
          const paidRegistrationRef = database.collection("event_registrations")
            .doc(paymentAttemptSnapshot.data().registrationId);
          const paidRegistrationSnapshot = await transaction.get(paidRegistrationRef);
          if (!paidRegistrationSnapshot.exists) throw new Error("Paid registration record is missing.");
          const paidRegistration = paidRegistrationSnapshot.data();
          return {
            registrationId: paidRegistration.registrationId,
            fullName: paidRegistration.fullName,
            registrationFee: REGISTRATION_FEE,
            paymentStatus: paidRegistration.paymentStatus,
            duplicate: true
          };
        }
        if (lockSnapshot.exists) {
          const lock = lockSnapshot.data();
          if (lock.requestDigest !== requestDigest) {
            const error = new Error("A registration for this email already exists.");
            error.statusCode = 409;
            throw error;
          }
          const existingRef = database.collection("event_registrations").doc(lock.registrationId);
          const existingSnapshot = await transaction.get(existingRef);
          if (!existingSnapshot.exists) throw new Error("Registration record is missing.");
          const existing = existingSnapshot.data();
          return {
            registrationId: existing.registrationId,
            fullName: existing.fullName,
            registrationFee: REGISTRATION_FEE,
            paymentStatus: existing.paymentStatus,
            duplicate: true
          };
        }

        transaction.create(registrationRef, {
          registrationId,
          ...registration,
          paymentStatus: "UNPAID",
          razorpayOrderId: null,
          razorpayPaymentId: null,
          registrationDate: FieldValue.serverTimestamp(),
          paidAt: null
        });
        transaction.create(lockRef, {
          registrationId,
          requestDigest,
          createdAt: Date.now()
        });
        return {
          registrationId,
          fullName: registration.fullName,
          registrationFee: REGISTRATION_FEE,
          paymentStatus: "UNPAID",
          duplicate: false
        };
      });
    },

    async createOrder(registration, orderFactory) {
      const lockRef = database.collection("payment_attempts").doc(emailLockId(registration.email));
      const requestDigest = createHmac("sha256", secret)
        .update(JSON.stringify(registration))
        .digest("hex");
      const generation = randomUUID();
      const now = Date.now();

      const result = await database.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(lockRef);
        const current = snapshot.exists ? snapshot.data() : null;
        if (current && current.status === "paid") {
          return { completed: true, registrationId: current.registrationId };
        }
        if (current && current.requestDigest !== requestDigest) {
          const error = new Error("A registration for this email is already in progress.");
          error.statusCode = 409;
          throw error;
        }
        if (current && current.orderId && current.status === "open") {
          return { orderId: current.orderId };
        }
        if (current && current.status === "creating" && now - current.updatedAt < 60_000) {
          const error = new Error("A payment order is already being prepared. Please try again shortly.");
          error.statusCode = 409;
          throw error;
        }
        transaction.set(lockRef, { status: "creating", requestDigest, generation, updatedAt: now });
        return { create: true };
      });

      if (result.completed || result.orderId) return result;

      try {
        const order = await orderFactory();
        await database.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(lockRef);
          const current = snapshot.exists ? snapshot.data() : null;
          if (!current || current.generation !== generation) {
            const error = new Error("The payment order request expired. Please try again.");
            error.statusCode = 409;
            throw error;
          }
          transaction.set(lockRef, {
            status: "open",
            requestDigest,
            generation,
            orderId: order.id,
            updatedAt: Date.now()
          });
        });
        return { orderId: order.id };
      } catch (error) {
        await database.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(lockRef);
          const current = snapshot.exists ? snapshot.data() : null;
          if (current && current.generation === generation) {
            transaction.set(lockRef, { status: "failed", requestDigest, updatedAt: Date.now() });
          }
        });
        throw error;
      }
    },

    async completeRegistration(registration, orderId, paymentId) {
      const lockRef = database.collection("payment_attempts").doc(emailLockId(registration.email));
      const requestDigest = createHmac("sha256", secret)
        .update(JSON.stringify(registration))
        .digest("hex");
      const registrationId = `FD26-${randomUUID().toUpperCase()}`;
      const registrationRef = database.collection("event_registrations").doc(registrationId);

      return database.runTransaction(async (transaction) => {
        const attemptSnapshot = await transaction.get(lockRef);
        if (!attemptSnapshot.exists) {
          const error = new Error("The payment order could not be found.");
          error.statusCode = 400;
          throw error;
        }
        const attempt = attemptSnapshot.data();
        if (attempt.status === "paid") {
          if (attempt.orderId !== orderId || attempt.paymentId !== paymentId) {
            const error = new Error("This registration has already been paid.");
            error.statusCode = 409;
            throw error;
          }
          const existingRef = database.collection("event_registrations").doc(attempt.registrationId);
          const existingSnapshot = await transaction.get(existingRef);
          if (!existingSnapshot.exists) throw new Error("Verified registration record is missing.");
          return {
            registrationId: attempt.registrationId,
            fullName: existingSnapshot.data().fullName,
            amountPaid: REGISTRATION_FEE,
            paymentStatus: "PAID"
          };
        }
        if (attempt.orderId !== orderId || attempt.requestDigest !== requestDigest) {
          const error = new Error("Payment details do not match this registration.");
          error.statusCode = 400;
          throw error;
        }

        const registrationDate = FieldValue.serverTimestamp();
        transaction.create(registrationRef, {
          registrationId,
          ...registration,
          paymentStatus: "PAID",
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          registrationDate,
          paidAt: registrationDate
        });
        transaction.set(lockRef, {
          ...attempt,
          status: "paid",
          registrationId,
          paymentId,
          updatedAt: Date.now()
        });
        return {
          registrationId,
          fullName: registration.fullName,
          amountPaid: REGISTRATION_FEE,
          paymentStatus: "PAID"
        };
      });
    },

    async findRegistrationForEmail(email) {
      const lockRef = database.collection("payment_attempts").doc(emailLockId(email));
      const snapshot = await lockRef.get();
      if (!snapshot.exists || snapshot.data().status !== "paid") return null;
      const registrationId = snapshot.data().registrationId;
      const registration = await database.collection("event_registrations").doc(registrationId).get();
      if (!registration.exists) throw new Error("Verified registration record is missing.");
      return {
        registrationId,
        fullName: registration.data().fullName,
        amountPaid: REGISTRATION_FEE,
        paymentStatus: "PAID"
      };
    }
  };
}

module.exports = { createRegistrationStore };