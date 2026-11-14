const { createHmac, randomUUID } = require("node:crypto");
const { REGISTRATION_FEE } = require("./registration-validation");

function createRegistrationStore(database) {
  const { FieldValue } = require("firebase-admin/firestore");
  const secret = process.env.REGISTRATION_LOCK_SECRET;
  if (!secret) throw new Error("REGISTRATION_LOCK_SECRET must be configured.");

  const emailLockId = (email) => createHmac("sha256", secret)
    .update(email.trim().toLowerCase())
    .digest("hex");
  const registrationDigest = (registration) => createHmac("sha256", secret)
    .update(JSON.stringify(Object.keys(registration).sort()
      .map((key) => [key, registration[key]])))
    .digest("hex");

  return {
    async createOrder(registration, orderFactory) {
      const lockRef = database.collection("payment_attempts").doc(emailLockId(registration.email));
      const orders = database.collection("payment_orders");
      const requestDigest = registrationDigest(registration);
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
        transaction.set(lockRef, {
          status: "creating",
          requestDigest,
          generation,
          registration,
          updatedAt: now
        });
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
            registration,
            orderId: order.id,
            updatedAt: Date.now()
          });
          transaction.set(orders.doc(order.id), {
            lockId: lockRef.id,
            createdAt: Date.now()
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
      const requestDigest = registrationDigest(registration);
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
        const paidAttempt = { ...attempt };
        delete paidAttempt.registration;
        transaction.set(lockRef, {
          ...paidAttempt,
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

    async hasWebhookEvent(eventId) {
      const eventSnapshot = await database.collection("webhook_events").doc(eventId).get();
      return eventSnapshot.exists;
    },

    async completeRegistrationForOrder(orderId, paymentId, eventId) {
      const eventRef = database.collection("webhook_events").doc(eventId);
      const orderRef = database.collection("payment_orders").doc(orderId);
      return database.runTransaction(async (transaction) => {
        const eventSnapshot = await transaction.get(eventRef);
        if (eventSnapshot.exists) return { duplicate: true };

        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists) {
          const error = new Error("The payment order could not be found.");
          error.statusCode = 400;
          throw error;
        }

        const lockRef = database.collection("payment_attempts").doc(orderSnapshot.data().lockId);
        const lockSnapshot = await transaction.get(lockRef);
        if (!lockSnapshot.exists) {
          throw new Error("The registration details for this payment could not be found.");
        }
        const attempt = lockSnapshot.data();

        if (attempt.status === "paid") {
          if (attempt.orderId !== orderId || attempt.paymentId !== paymentId) {
            const error = new Error("This registration has already been paid.");
            error.statusCode = 409;
            throw error;
          }
          const registrationRef = database.collection("event_registrations")
            .doc(attempt.registrationId);
          const registrationSnapshot = await transaction.get(registrationRef);
          if (!registrationSnapshot.exists) throw new Error("Verified registration record is missing.");
          transaction.set(eventRef, { processedAt: Date.now() });
          return {
            duplicate: false,
            registration: {
              registrationId: attempt.registrationId,
              fullName: registrationSnapshot.data().fullName,
              amountPaid: REGISTRATION_FEE,
              paymentStatus: "PAID"
            }
          };
        }

        if (!attempt.registration || attempt.orderId !== orderId ||
            attempt.requestDigest !== registrationDigest(attempt.registration)) {
          const error = new Error("Payment details do not match this registration.");
          error.statusCode = 400;
          throw error;
        }

        const registrationId = `FD26-${randomUUID().toUpperCase()}`;
        const registrationRef = database.collection("event_registrations").doc(registrationId);
        const registrationDate = FieldValue.serverTimestamp();
        transaction.create(registrationRef, {
          registrationId,
          ...attempt.registration,
          paymentStatus: "PAID",
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          registrationDate,
          paidAt: registrationDate
        });
        const paidAttempt = { ...attempt };
        delete paidAttempt.registration;
        transaction.set(lockRef, {
          ...paidAttempt,
          status: "paid",
          registrationId,
          paymentId,
          updatedAt: Date.now()
        });
        transaction.set(eventRef, { processedAt: Date.now() });
        return {
          duplicate: false,
          registration: {
            registrationId,
            fullName: attempt.registration.fullName,
            amountPaid: REGISTRATION_FEE,
            paymentStatus: "PAID"
          }
        };
      });
    },

    async recordFailedPayment(orderId, paymentId, eventId) {
      const orderRef = database.collection("payment_orders").doc(orderId);
      const eventRef = database.collection("webhook_events").doc(eventId);
      return database.runTransaction(async (transaction) => {
        const eventSnapshot = await transaction.get(eventRef);
        if (eventSnapshot.exists) return false;

        const orderSnapshot = await transaction.get(orderRef);
        if (!orderSnapshot.exists) {
          const error = new Error("The payment order could not be found.");
          error.statusCode = 400;
          throw error;
        }
        const lockRef = database.collection("payment_attempts").doc(orderSnapshot.data().lockId);
        const lockSnapshot = await transaction.get(lockRef);
        if (!lockSnapshot.exists) {
          const error = new Error("The payment attempt could not be found.");
          error.statusCode = 400;
          throw error;
        }

        const attempt = lockSnapshot.data();
        if (attempt.status !== "paid") {
          transaction.set(lockRef, {
            ...attempt,
            lastFailurePaymentId: paymentId,
            lastFailureAt: Date.now()
          });
        }
        transaction.set(eventRef, { processedAt: Date.now() });
        return true;
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