const { createHash, createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const {
  REGISTRATION_FEE,
  ValidationError,
  validateRegistration
} = require("./registration-validation");

const PAISA_AMOUNT = REGISTRATION_FEE * 100;

function createRegistrationRouter({ store, paymentsEnabled = true }) {
  const router = express.Router();
  router.post("/webhooks/razorpay", handleRazorpayWebhook);
  router.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many requests. Please wait and try again." }
  }));

  router.post("/orders", async (request, response) => {
    if (!paymentsEnabled) {
      return response.status(410).json({ error: "Online payment is currently unavailable." });
    }
    try {
      const registration = validateRegistration(request.body);
      assertRazorpayConfiguration();
      const existing = await store.findRegistrationForEmail(registration.email);
      if (existing) return response.json({ completed: true, registration: existing });

      const result = await store.createOrder(registration, createRazorpayOrder);
      if (result.completed) {
        const saved = await store.findRegistrationForEmail(registration.email);
        return response.json({ completed: true, registration: saved });
      }
      return response.json({
        orderId: result.orderId,
        amount: PAISA_AMOUNT,
        currency: "INR",
        keyId: process.env.RAZORPAY_KEY_ID,
        name: registration.fullName,
        email: registration.email,
        mobile: registration.mobile
      });
    } catch (error) {
      if (error.statusCode === 503) {
        return response.status(503).json({ error: "Online payment is currently unavailable." });
      }
      if (error instanceof ValidationError || error.statusCode === 409) {
        return response.status(error.statusCode).json({ error: error.message });
      }
      console.error("Unable to create payment order:", error);
      return response.status(500).json({ error: "Unable to start payment. Please try again." });
    }
  });

  router.post("/verify", async (request, response) => {
    return verifyPayment(request, response);
  });

  router.post("/recover", async (request, response) => {
    return verifyPayment(request, response);
  });

  async function verifyPayment(request, response) {
    if (!paymentsEnabled) {
      return response.status(410).json({ error: "Online payment is currently unavailable." });
    }
    try {
      const registration = validateRegistration(request.body);
      assertRazorpayConfiguration();
      const {
        razorpay_order_id: orderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: signature
      } = request.body || {};
      if (typeof orderId !== "string" || typeof paymentId !== "string" ||
          typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) {
        return response.status(400).json({ error: "Payment verification details are invalid." });
      }

      verifySignature(orderId, paymentId, signature);
      await verifyCapturedPayment(orderId, paymentId);
      const result = await store.completeRegistration(registration, orderId, paymentId);
      return response.json({ registration: result });
    } catch (error) {
      if (error.statusCode === 503) {
        return response.status(503).json({ error: "Payment verification is currently unavailable." });
      }
      if (error instanceof ValidationError || error.statusCode === 400 || error.statusCode === 409) {
        return response.status(error.statusCode).json({ error: error.message });
      }
      console.error("Unable to verify payment:", error);
      return response.status(500).json({ error: "Payment verification could not be completed. Please retry." });
    }
  }

  async function createRazorpayOrder() {
    const result = await razorpayRequest("POST", "/v1/orders", {
      amount: PAISA_AMOUNT,
      currency: "INR",
      receipt: `FD26-${randomUUID().replace(/-/g, "")}`
    });
    if (!result || typeof result.id !== "string") throw new Error("Razorpay returned an invalid order.");
    return result;
  }

  function verifySignature(orderId, paymentId, signature) {
    const expected = createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest();
    const supplied = Buffer.from(signature, "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      const error = new Error("Payment signature verification failed.");
      error.statusCode = 400;
      throw error;
    }
  }

  async function handleRazorpayWebhook(request, response) {
    const rawBody = request.body;
    const signature = request.get("x-razorpay-signature");
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
      return response.status(503).json({ error: "Webhook verification is not configured." });
    }
    if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature)) {
      return response.status(400).json({ error: "Webhook signature verification failed." });
    }

    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return response.status(400).json({ error: "Webhook payload is invalid." });
    }

    const payment = event && event.payload && event.payload.payment &&
      event.payload.payment.entity;
    if (!payment || typeof payment.id !== "string" ||
        typeof payment.order_id !== "string") {
      return response.status(200).json({ received: true, ignored: true });
    }

    const eventId = typeof event.id === "string" && event.id
      ? createHash("sha256").update(event.id).digest("hex")
      : createHash("sha256").update(rawBody).digest("hex");

    try {
      if (event.event === "payment.captured") {
        if (payment.status !== "captured" || payment.amount !== PAISA_AMOUNT ||
            payment.currency !== "INR") {
          return response.status(400).json({ error: "Captured payment details are invalid." });
        }
        if (await store.hasWebhookEvent(eventId)) {
          return response.json({ received: true, duplicate: true });
        }
        await verifyCapturedPayment(payment.order_id, payment.id);
        const result = await store.completeRegistrationForOrder(
          payment.order_id,
          payment.id,
          eventId
        );
        return response.json({ received: true, ...result });
      }

      if (event.event === "payment.failed") {
        if (await store.hasWebhookEvent(eventId)) {
          return response.json({ received: true, duplicate: true });
        }
        if (payment.status !== "failed") {
          return response.status(400).json({ error: "Failed payment details are invalid." });
        }
        const duplicate = !(await store.recordFailedPayment(
          payment.order_id,
          payment.id,
          eventId
        ));
        return response.json({ received: true, duplicate });
      }

      return response.json({ received: true, ignored: true });
    } catch (error) {
      if (error.statusCode === 503) {
        return response.status(503).json({ error: "Webhook verification is currently unavailable." });
      }
      if (error.statusCode === 400 || error.statusCode === 409) {
        return response.status(error.statusCode).json({ error: error.message });
      }
      console.error("Unable to process Razorpay webhook:", error);
      return response.status(500).json({ error: "Webhook processing could not be completed." });
    }
  }

  function verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret || typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) {
      return false;
    }
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const supplied = Buffer.from(signature, "hex");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  function assertRazorpayConfiguration() {
    const mode = process.env.RAZORPAY_MODE || "test";
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const expectedPrefix = mode === "test" ? "rzp_test_" : mode === "live" ? "rzp_live_" : null;
    const keyIdPresent = typeof keyId === "string" && keyId.length > 0;
    const keyIdPrefixMatchesMode = Boolean(
      expectedPrefix && keyIdPresent && keyId.startsWith(expectedPrefix)
    );
    const keySecretPresent = typeof keySecret === "string" && keySecret.length > 0;
    if (!expectedPrefix || !keyIdPrefixMatchesMode || !keySecretPresent) {
      console.error("Razorpay configuration rejected:", {
        mode: expectedPrefix ? mode : "unsupported",
        keyIdPresent,
        keyIdPrefixMatchesMode,
        keySecretPresent
      });
      const error = new Error("Razorpay credentials must match the explicitly configured payment mode.");
      error.statusCode = 503;
      throw error;
    }
  }

  async function verifyCapturedPayment(orderId, paymentId) {
    const payment = await razorpayRequest("GET", `/v1/payments/${encodeURIComponent(paymentId)}`);
    if (!payment || payment.order_id !== orderId || payment.amount !== PAISA_AMOUNT ||
        payment.currency !== "INR" || payment.status !== "captured") {
      const error = new Error("Payment is not captured for the required amount.");
      error.statusCode = 409;
      throw error;
    }
  }

  async function razorpayRequest(method, endpoint, body) {
    assertRazorpayConfiguration();
    const credentials = Buffer.from(
      `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`
    ).toString("base64");
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 10_000);
    try {
      const result = await fetch(`https://api.razorpay.com${endpoint}`, {
        method,
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: abortController.signal
      });
      const payload = await result.json().catch(() => null);
      if (!result.ok) {
        console.error("Razorpay API request failed:", result.status,
          payload && payload.error && payload.error.code);
        throw new Error("Razorpay API request failed.");
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  return router;
}

module.exports = { createRegistrationRouter };