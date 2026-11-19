const test = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../server");

const environmentNames = [
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD",
  "ADMIN_PASSWORD_HASH",
  "ADMIN_SESSION_SECRET",
  "SESSION_SECRET"
];

async function withServer(callback, sessionSecret) {
  const previous = Object.fromEntries(
    environmentNames.map((name) => [name, process.env[name]])
  );
  process.env.ADMIN_EMAIL = "admin@example.test";
  process.env.ADMIN_PASSWORD = "test-admin-password";
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_SESSION_SECRET;
  delete process.env.SESSION_SECRET;
  if (sessionSecret !== undefined) {
    process.env.ADMIN_SESSION_SECRET = sessionSecret;
  }

  const server = createApp().listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(address);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("admin login and protected screenshots fail closed without a session secret", async () => {
  await withServer(async (address) => {
    const login = await fetch(`${address}/admin/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "test-admin-password"
      })
    });
    assert.equal(login.status, 503);
    assert.equal((await login.json()).error, "Admin access is not configured.");

    const screenshot = await fetch(
      `${address}/admin/api/manual/registrations/FD26-M-000000000001/screenshot`,
      { headers: { Accept: "application/json" } }
    );
    assert.equal(screenshot.status, 503);
    assert.equal((await screenshot.json()).error, "Admin access is not configured.");
  });
});

test("admin authentication rejects a session secret shorter than 32 characters", async () => {
  await withServer(async (address) => {
    const response = await fetch(`${address}/admin/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        email: "admin@example.test",
        password: "test-admin-password"
      })
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "Admin access is not configured.");
  }, "short-session-key");
});
