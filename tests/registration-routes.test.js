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
  const originalMode = process.env.RAZORPAY_MODE;
  const originalWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  global.fetch = (url, options) => {
    if (String(url).startsWith("http://127.0.0.1:")) return originalFetch(url, options);
    return fetchHandler(url, options);
  };
  process.env.RAZORPAY_KEY_ID = options.keyId === undefined ? "rzp_test_public" : options.keyId;
  process.env.RAZORPAY_KEY_SECRET = options.keySecret === undefined
    ? "test_secret"
    : options.keySecret;
  process.env.RAZORPAY_MODE = options.mode === undefined ? "test" : options.mode;
  process.env.RAZORPAY_WEBHOOK_SECRET = options.webhookSecret === undefined
    ? "webhook_test_secret"
    : options.webhookSecret;

  const webhookEvents = new Set();
  const state = {
    completedOrders: [],
    failedPayments: [],
    store: {
      findRegistrationForEmail: async () => null,
      createOrder: async (_details, orderFactory) => ({ orderId: (await orderFactory()).id }),
      completeRegistration: async (details) => ({
        registrationId: "FD26-TEST",
        fullName: details.fullName,
        amountPaid: 250,
        paymentStatus: "PAID"
      }),
      hasWebhookEvent: async (eventId) => webhookEvents.has(eventId),
      completeRegistrationForOrder: async (orderId, paymentId, eventId) => {
        if (webhookEvents.has(eventId)) return { duplicate: true };
        webhookEvents.add(eventId);
        state.completedOrders.push({ orderId, paymentId });
        return {
          duplicate: false,
          registration: {
            registrationId: "FD26-WEBHOOK",
            fullName: registration.fullName,
            amountPaid: 250,
            paymentStatus: "PAID"
          }
        };
      },
      recordFailedPayment: async (orderId, paymentId, eventId) => {
        if (webhookEvents.has(eventId)) return false;
        webhookEvents.add(eventId);
        state.failedPayments.push({ orderId, paymentId });
        return true;
      }
    }
  };
  const store = {
    ...state.store,
    ...options.store
  };
  const server = createApp({ store, paymentsEnabled: options.paymentsEnabled }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;

  try {
    await callback(address, state);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    global.fetch = originalFetch;
    if (originalKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKeyId;
    if (originalSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalSecret;
    if (originalMode === undefined) delete process.env.RAZORPAY_MODE;
    else process.env.RAZORPAY_MODE = originalMode;
    if (originalWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = originalWebhookSecret;
  }
}

function webhookRequest(address, event, secret = "webhook_test_secret") {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return fetch(`${address}/api/webhooks/razorpay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": signature
    },
    body
  });
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

test("keeps payment endpoints disabled when explicitly configured", async () => {
  await withServer(async () => {
    throw new Error("No external payment request should be made.");
  }, async (address) => {
    const response = await fetch(`${address}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration)
    });
    assert.equal(response.status, 410);
  }, { paymentsEnabled: false });
});

test("does not use Test Mode credentials when Live Mode is selected", async () => {
  await withServer(async () => {
    throw new Error("A mode mismatch must not send a Razorpay request.");
  }, async (address) => {
    const response = await fetch(`${address}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration)
    });
    assert.equal(response.status, 503);
  }, { mode: "live" });
});

test("returns service-unavailable responses when payment secrets are missing", async () => {
  await withServer(async () => {
    throw new Error("Missing credentials must not call Razorpay.");
  }, async (address) => {
    const order = await fetch(`${address}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration)
    });
    assert.equal(order.status, 503);

    const webhook = await fetch(`${address}/api/webhooks/razorpay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "payment.failed" })
    });
    assert.equal(webhook.status, 503);
  }, { keyId: "", keySecret: "", webhookSecret: "" });
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

test("rejects a payment with an incorrect amount", async () => {
  const signature = createHmac("sha256", "test_secret")
    .update("order_test|pay_test")
    .digest("hex");
  await withServer(async () => Response.json({
    order_id: "order_test",
    amount: 24900,
    currency: "INR",
    status: "captured"
  }), async (address) => {
    const response = await fetch(`${address}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...registration,
        razorpay_order_id: "order_test",
        razorpay_payment_id: "pay_test",
        razorpay_signature: signature
      })
    });
    assert.equal(response.status, 409);
  });
});

test("rejects a captured payment associated with a different order", async () => {
  const signature = createHmac("sha256", "test_secret")
    .update("order_test|pay_test")
    .digest("hex");
  await withServer(async () => Response.json({
    order_id: "another_order",
    amount: 25000,
    currency: "INR",
    status: "captured"
  }), async (address) => {
    const response = await fetch(`${address}/api/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...registration,
        razorpay_order_id: "order_test",
        razorpay_payment_id: "pay_test",
        razorpay_signature: signature
      })
    });
    assert.equal(response.status, 409);
  });
});

test("rejects payments that are not captured in INR", async () => {
  let payment;
  await withServer(async () => Response.json(payment), async (address) => {
    for (const [paymentId, details] of [
      ["pay_wrong_currency", { currency: "USD", status: "captured" }],
      ["pay_uncaptured", { currency: "INR", status: "authorized" }]
    ]) {
      payment = {
        order_id: "order_test",
        amount: 25000,
        ...details
      };
      const signature = createHmac("sha256", "test_secret")
        .update(`order_test|${paymentId}`)
        .digest("hex");
      const response = await fetch(`${address}/api/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...registration,
          razorpay_order_id: "order_test",
          razorpay_payment_id: paymentId,
          razorpay_signature: signature
        })
      });
      assert.equal(response.status, 409);
    }
  });
});

test("recovers a captured payment through the server-side verification path", async () => {
  const signature = createHmac("sha256", "test_secret")
    .update("order_test|pay_test")
    .digest("hex");
  await withServer(async () => Response.json({
    order_id: "order_test",
    amount: 25000,
    currency: "INR",
    status: "captured"
  }), async (address) => {
    const response = await fetch(`${address}/api/recover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...registration,
        razorpay_order_id: "order_test",
        razorpay_payment_id: "pay_test",
        razorpay_signature: signature
      })
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.registration.registrationId, "FD26-TEST");
  });
});

test("processes a captured webhook once despite duplicate delivery", async () => {
  let verificationRequests = 0;
  const event = {
    id: "evt_capture_test",
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_test",
          order_id: "order_test",
          amount: 25000,
          currency: "INR",
          status: "captured"
        }
      }
    }
  };
  await withServer(async (_url, options) => {
    verificationRequests += 1;
    assert.equal(options.method, "GET");
    return Response.json({
      order_id: "order_test",
      amount: 25000,
      currency: "INR",
      status: "captured"
    });
  }, async (address, state) => {
    const first = await webhookRequest(address, event);
    const duplicate = await webhookRequest(address, event);
    const firstResult = await first.json();
    const duplicateResult = await duplicate.json();

    assert.equal(first.status, 200);
    assert.equal(firstResult.duplicate, false);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicateResult.duplicate, true);
    assert.equal(state.completedOrders.length, 1);
    assert.equal(verificationRequests, 1);
  });
});

test("rejects invalid webhook signatures and payment amounts", async () => {
  const event = {
    id: "evt_bad_test",
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_test",
          order_id: "order_test",
          amount: 24900,
          currency: "INR",
          status: "captured"
        }
      }
    }
  };
  await withServer(async () => {
    throw new Error("Invalid webhook must not contact Razorpay.");
  }, async (address) => {
    const invalidSignature = await webhookRequest(address, event, "wrong_secret");
    assert.equal(invalidSignature.status, 400);
    const incorrectAmount = await webhookRequest(address, event);
    assert.equal(incorrectAmount.status, 400);
  });
});

test("records failed payment webhooks without completing registration", async () => {
  const event = {
    id: "evt_failed_test",
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: "pay_failed",
          order_id: "order_test",
          status: "failed"
        }
      }
    }
  };
  await withServer(async () => {
    throw new Error("Failed payment webhooks do not query captured payment.");
  }, async (address, state) => {
    const response = await webhookRequest(address, event);
    const duplicate = await webhookRequest(address, event);
    const result = await response.json();
    const duplicateResult = await duplicate.json();
    assert.equal(response.status, 200);
    assert.equal(result.duplicate, false);
    assert.equal(duplicateResult.duplicate, true);
    assert.deepEqual(state.failedPayments, [{ orderId: "order_test", paymentId: "pay_failed" }]);
  });
});
