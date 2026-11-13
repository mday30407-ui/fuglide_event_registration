const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { createApp } = require("../server");

const registration = {
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
};

async function withServer(fetchHandler, callback, options = {}) {
  const originalFetch = global.fetch;
  const originalKeyId = process.env.RAZORPAY_KEY_ID;
  const originalSecret = process.env.RAZORPAY_KEY_SECRET;
  global.fetch = (url, options) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    return fetchHandler(url, options);
  };
  process.env.RAZORPAY_KEY_ID = "rzp_test_public";
  process.env.RAZORPAY_KEY_SECRET = "test_secret";

  const store = {
    submitRegistration: async (details) => ({
      registrationId: "FD26-TEST",
      fullName: details.fullName,
      registrationFee: details.registrationFee,
      paymentStatus: "UNPAID",
      duplicate: false
    }),
    findRegistrationForEmail: async () => null,
    createOrder: async (_details, orderFactory) => ({ orderId: (await orderFactory()).id }),
    completeRegistration: async (details) => ({
      registrationId: "FD26-TEST",
      fullName: details.fullName,
      amountPaid: 250,
      paymentStatus: "PAID"
    })
  };
  const server = createApp({ store, paymentsEnabled: options.paymentsEnabled === true }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;

  try {
    await callback(address);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    global.fetch = originalFetch;
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalSecret;
  }
}

test("creates a server-priced ₹250 INR order and validates required details", async () => {
  let orderRequest;
  await withServer(async (_url, options) => {
    orderRequest = JSON.parse(options.body);
    return Response.json({ id: "order_test" });
  }, async (address) => {
    const invalid = await fetch(`${address}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...registration, fullName: "" })
    });
    assert.equal(invalid.status, 400);

    const response = await fetch(`${address}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...registration, registrationFee: 1, currency: "USD" })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(orderRequest.amount, 25000);
    assert.equal(orderRequest.currency, "INR");
    assert.ok(orderRequest.receipt.length <= 40);
    assert.equal(result.amount, 25000);
    assert.equal(result.currency, "INR");
    assert.equal(result.keyId, "rzp_test_public");
  }, { paymentsEnabled: true });
});

test("saves an unpaid registration and keeps payment endpoints disabled", async () => {
  await withServer(async () => {
    throw new Error("No external payment request should be made.");
  }, async (address) => {
    const response = await fetch(`${address}/api/registrations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...registration, registrationFee: 1, currency: "USD" })
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.registration.registrationFee, 250);
    assert.equal(result.registration.paymentStatus, "UNPAID");

    const payment = await fetch(`${address}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration)
    });
    assert.equal(payment.status, 410);
  });
});

test("rejects bad signatures and only records captured matching payments", async () => {
  const paymentSignature = createHmac("sha256", "test_secret")
    .update("order_test|pay_test")
    .digest("hex");

  await withServer(async (url, options) => {
    assert.equal(url, "https://api.razorpay.com/v1/payments/pay_test");
    assert.equal(options.method, "GET");
    return Response.json({
      order_id: "order_test",
      amount: 25000,
      currency: "INR",
      status: "captured"
    });
  }, async (address) => {
    const badSignature = await fetch(`${address}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...registration,
        razorpay_order_id: "order_test",
        razorpay_payment_id: "pay_test",
        razorpay_signature: "0".repeat(64)
      })
    });
    assert.equal(badSignature.status, 400);

    const validPayment = await fetch(`${address}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...registration,
        razorpay_order_id: "order_test",
        razorpay_payment_id: "pay_test",
        razorpay_signature: paymentSignature
      })
    });
    const result = await validPayment.json();
    assert.equal(validPayment.status, 200);
    assert.equal(result.registration.paymentStatus, "PAID");
    assert.equal(result.registration.amountPaid, 250);
  }, { paymentsEnabled: true });
});
