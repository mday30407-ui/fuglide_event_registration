const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");
const {
  parseScreenshotPath,
  ScreenshotNotFoundError
} = require("../src/manual-storage");

const registrationId = "FD26-M-000000000001";
const screenshotPath =
  `supabase/manual-payment-screenshots/${registrationId}/00000000-0000-4000-8000-000000000001.png`;
const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function createDatabase(objectPath = screenshotPath) {
  return {
    collection(name) {
      return {
        doc(id) {
          assert.equal(name, "manual_payment_registrations");
          assert.equal(id, registrationId);
          return {
            async get() {
              return {
                exists: true,
                data: () => ({ paymentScreenshotStoragePath: objectPath })
              };
            }
          };
        }
      };
    }
  };
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

async function withServer(callback, { database, screenshotStorage }) {
  const restoreEnvironment = setAdminEnvironment();
  const server = createApp({ database, manualStorage: screenshotStorage }).listen(0);
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
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

test("requires admin authentication and streams the Supabase object without a public URL", async () => {
  const calls = [];
  const screenshotStorage = {
    async getScreenshot(objectPath) {
      calls.push(objectPath);
      return screenshot;
    }
  };
  await withServer(async (address) => {
    const endpoint = `${address}/admin/api/manual/registrations/${registrationId}/screenshot`;
    const unauthorized = await fetch(endpoint, {
      headers: { Accept: "application/json" }
    });
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(calls, []);

    const cookie = await authenticate(address);
    const response = await fetch(endpoint, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), screenshot);
    assert.deepEqual(calls, [screenshotPath]);
    assert.doesNotMatch(response.headers.get("content-disposition"), /supabase|payment-screenshots/);
  }, {
    database: createDatabase(),
    screenshotStorage
  });
});

test("rejects a malformed stored path and responds safely when the object is missing", async () => {
  let storageCalls = 0;
  const screenshotStorage = {
    async getScreenshot(objectPath) {
      storageCalls += 1;
      parseScreenshotPath(objectPath);
      throw new ScreenshotNotFoundError();
    }
  };

  await withServer(async (address) => {
    const cookie = await authenticate(address);
    const invalidResponse = await fetch(
      `${address}/admin/api/manual/registrations/${registrationId}/screenshot`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(invalidResponse.status, 404);
    assert.equal(storageCalls, 1);
  }, {
    database: createDatabase(
      `supabase/manual-payment-screenshots/../${registrationId}/image.png`
    ),
    screenshotStorage
  });

  const missingStorage = {
    async getScreenshot() {
      storageCalls += 1;
      throw new ScreenshotNotFoundError();
    }
  };
  await withServer(async (address) => {
    const cookie = await authenticate(address);
    const missingResponse = await fetch(
      `${address}/admin/api/manual/registrations/${registrationId}/screenshot`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(missingResponse.status, 404);
    assert.equal(storageCalls, 2);
  }, {
    database: createDatabase(),
    screenshotStorage: missingStorage
  });
});
