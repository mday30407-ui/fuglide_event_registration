const test = require("node:test");
const assert = require("node:assert/strict");
const { createHmac } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

const originalModuleLoad = Module._load;
const firebaseImportsDuringStartup = [];
Module._load = function (request, parent, isMain) {
  if (typeof request === "string" && request.startsWith("firebase-admin/")) {
    firebaseImportsDuringStartup.push(request);
  }
  return originalModuleLoad.apply(this, arguments);
};
let app;
try {
  app = require("../index");
} finally {
  Module._load = originalModuleLoad;
}
const { createApp } = require("../server");
const firebaseEnvironmentKeys = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_SERVICE_ACCOUNT",
  "REGISTRATION_LOCK_SECRET",
  "RAZORPAY_MODE",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET"
];
const testRegistration = {
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
const testPaymentEnvironment = {
  RAZORPAY_MODE: "test",
  RAZORPAY_KEY_ID: "rzp_test_public",
  RAZORPAY_KEY_SECRET: "test_secret",
  RAZORPAY_WEBHOOK_SECRET: "test_webhook_secret"
};

async function withServer(callback, targetApp = app) {
  const server = targetApp.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(address);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function withFirebaseEnvironment(values, callback) {
  const previous = {};
  for (const key of firebaseEnvironmentKeys) {
    previous[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }

  try {
    return await callback();
  } finally {
    for (const key of firebaseEnvironmentKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function captureInitializationErrors(callback) {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    await callback();
    return errors;
  } finally {
    console.error = originalError;
  }
}

async function withRazorpayApi(callback) {
  const originalFetch = global.fetch;
  global.fetch = (url, options) => {
    if (String(url).startsWith("http://127.0.0.1:")) {
      return originalFetch(url, options);
    }
    return Promise.resolve(Response.json({
      order_id: "order_test",
      amount: 25000,
      currency: "INR",
      status: "captured"
    }));
  };
  try {
    return await callback();
  } finally {
    global.fetch = originalFetch;
  }
}

test("loads the Vercel entrypoint without importing Firebase Admin", () => {
  assert.deepEqual(firebaseImportsDuringStartup, []);
});

test("logs a sanitized diagnostic when entrypoint module loading fails", () => {
  const projectRoot = path.join(__dirname, "..");
  const entrypoint = path.join(projectRoot, "index.js");
  const probe = `
    const Module = require("node:module");
    const originalLoad = Module._load;
    console.error = (message, details) => {
      process.stdout.write(JSON.stringify({ message, details }) + "\\n");
    };
    Module._load = function (request, parent, isMain) {
      if (request === "express") throw new Error("simulated module import failure");
      return originalLoad.apply(this, arguments);
    };
    try {
      require(${JSON.stringify(entrypoint)});
    } catch (error) {
      process.stdout.write("CAUGHT:" + error.message);
    }
  `;
  const output = execFileSync(process.execPath, ["-e", probe], {
    cwd: projectRoot,
    encoding: "utf8"
  });

  assert.match(output, /"stage":"module-import"/);
  assert.match(output, /"message":"simulated module import failure"/);
  assert.match(output, /CAUGHT:simulated module import failure/);
  assert.doesNotMatch(output, /stack|private_key|secret/i);
});

test("exports an Express Vercel function and serves the frontend without Firebase", async () => {
  assert.equal(typeof app, "function");
  assert.equal(app.config.api.bodyParser, false);

  await withFirebaseEnvironment({}, async () => {
    await withServer(async (address) => {
      const page = await fetch(address);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /FOUNDER'S DIARY/);

      const asset = await fetch(`${address}/app.js`);
      assert.equal(asset.status, 200);
      const script = await asset.text();
      assert.match(script, /\/api\/orders/);
      assert.doesNotMatch(script, /wa\.me|openWhatsApp/);

      const favicon = await fetch(`${address}/favicon.ico`);
      assert.equal(favicon.status, 404);
    });
  });
});

test("routes Vercel API requests through Express without exposing private files", async () => {
  const projectRoot = path.join(__dirname, "..");
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vercel.json"), "utf8"));
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  assert.equal(packageJson.main, "server.js");
  assert.equal(typeof require("../server"), "function");
  assert.equal(require("../server"), app);
  assert.equal(app.config.api.bodyParser, false);
  assert.equal(vercel.functions["server.js"].maxDuration, 30);
  assert.equal(vercel.functions["server.js"].includeFiles, "index.html");
  assert.equal(vercel.rewrites, undefined);
  const apiDirectory = path.join(projectRoot, "api");
  assert.deepEqual(fs.existsSync(apiDirectory)
    ? fs.readdirSync(apiDirectory, { recursive: true })
    : [], []);

  await withFirebaseEnvironment({
    FIREBASE_PROJECT_ID: "test-vercel-project",
    REGISTRATION_LOCK_SECRET: "test-registration-lock-secret",
    ...testPaymentEnvironment
  }, async () => {
    await withServer(async (address) => {
      const apiResponse = await fetch(`${address}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(apiResponse.status, 400);

      const privateFile = await fetch(`${address}/firebase-service-account.json`);
      assert.equal(privateFile.status, 404);
    }, createApp());
  });
});

test("returns a safe API error and logs missing Firebase configuration", async () => {
  await withFirebaseEnvironment(testPaymentEnvironment, async () => {
    const errors = await captureInitializationErrors(() => withServer(async (address) => {
      const page = await fetch(address);
      assert.equal(page.status, 200);

      const response = await fetch(`${address}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testRegistration)
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "Online payment is currently unavailable.");
    }, createApp()));

    assert.equal(errors.length, 1);
    assert.equal(errors[0][0], "Unable to initialize database-backed API:");
    assert.match(errors[0][1].message, /FIREBASE_PROJECT_ID must be configured/);
  });
});

test("returns a safe API error when the registration lock secret is missing", async () => {
  await withFirebaseEnvironment({
    FIREBASE_PROJECT_ID: "test-vercel-project",
    ...testPaymentEnvironment
  }, async () => {
    const errors = await captureInitializationErrors(() => withServer(async (address) => {
      const response = await fetch(`${address}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testRegistration)
      });
      assert.equal(response.status, 503);
    }, createApp()));

    assert.equal(errors.length, 1);
    assert.match(errors[0][1].message, /REGISTRATION_LOCK_SECRET must be configured/);
  });
});

test("returns a safe API error when Firebase service-account JSON is malformed", async () => {
  await withFirebaseEnvironment({
    FIREBASE_PROJECT_ID: "test-vercel-project",
    FIREBASE_SERVICE_ACCOUNT: "{\"private_key\":",
    REGISTRATION_LOCK_SECRET: "test-registration-lock-secret",
    ...testPaymentEnvironment
  }, async () => {
    const errors = await captureInitializationErrors(() => withServer(async (address) => {
      const response = await fetch(`${address}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testRegistration)
      });
      assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /FIREBASE_SERVICE_ACCOUNT/);
    }, createApp()));

    assert.equal(errors.length, 1);
    assert.match(errors[0][1].message, /FIREBASE_SERVICE_ACCOUNT must contain valid JSON/);
  });
});

test("fails all API routes safely when Firebase service-account credentials are invalid", async () => {
  await withFirebaseEnvironment({
    FIREBASE_PROJECT_ID: "test-vercel-project",
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "test-vercel-project",
      client_email: "service@test-vercel-project.iam.gserviceaccount.com",
      private_key: "not-a-private-key"
    }),
    REGISTRATION_LOCK_SECRET: "test-registration-lock-secret",
    ...testPaymentEnvironment
  }, async () => {
    const errors = await captureInitializationErrors(() => withRazorpayApi(() =>
      withServer(async (address) => {
        const orderResponse = await fetch(`${address}/api/orders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testRegistration)
        });

        const paymentSignature = createHmac("sha256", "test_secret")
          .update("order_test|payment_test")
          .digest("hex");
        const paymentDetails = {
          ...testRegistration,
          razorpay_order_id: "order_test",
          razorpay_payment_id: "payment_test",
          razorpay_signature: paymentSignature
        };
        const verifyResponse = await fetch(`${address}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(paymentDetails)
        });
        const recoverResponse = await fetch(`${address}/api/recover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(paymentDetails)
        });

        const eventBody = JSON.stringify({
          id: "event_test",
          event: "payment.captured",
          payload: {
            payment: {
              entity: {
                id: "payment_test",
                order_id: "order_test",
                status: "captured",
                amount: 25000,
                currency: "INR"
              }
            }
          }
        });
        const eventSignature = createHmac("sha256", "test_webhook_secret")
          .update(eventBody)
          .digest("hex");
        const webhookResponse = await fetch(`${address}/api/webhooks/razorpay`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Razorpay-Signature": eventSignature
          },
          body: eventBody
        });

        for (const response of [
          orderResponse,
          verifyResponse,
          recoverResponse,
          webhookResponse
        ]) {
          assert.equal(response.status, 503);
          assert.doesNotMatch(await response.text(), /private key|not-a-private-key/i);
        }
      }, createApp())
    ));

    assert.equal(errors.length, 4);
    for (const error of errors) {
      assert.match(error[1].message, /Failed to parse private key/);
      assert.doesNotMatch(error[1].message, /not-a-private-key/);
    }
  });
});
