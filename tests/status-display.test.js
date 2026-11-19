const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const scriptPaths = [
  path.join(__dirname, "..", "status.js"),
  path.join(__dirname, "..", "public", "status.js")
];
const verifiedMessage =
  "PAYMENT VERIFIED — INVITATION WILL BE SENT TO YOUR WHATSAPP NUMBER BY OUR TEAM.";
const rejectionFallback =
  "Your payment verification was rejected. Please contact the event team for assistance.";

async function renderStatus(scriptPath, payload) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        const classes = new Set();
        elements.set(id, {
          addEventListener(eventName, handler) {
            this.listeners[eventName] = handler;
          },
          classList: {
            add(...names) {
              names.forEach((name) => classes.add(name));
            },
            remove(...names) {
              names.forEach((name) => classes.delete(name));
            },
            contains(name) {
              return classes.has(name);
            }
          },
          hidden: false,
          listeners: {},
          textContent: "",
          value: ""
        });
      }
      return elements.get(id);
    }
  };
  const source = fs.readFileSync(scriptPath, "utf8");

  vm.runInNewContext(source, {
    document,
    fetch: async () => ({
      ok: true,
      json: async () => payload
    }),
    URLSearchParams,
    window: { location: { hash: "" } }
  }, { filename: scriptPath });

  document.getElementById("status-registration-id").value = "FD26-M-ABCDEF123456";
  document.getElementById("status-access-token").value = "private-token";
  document.getElementById("status-form").listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  return {
    message: document.getElementById("status-message"),
    icon: document.getElementById("status-message-icon"),
    text: document.getElementById("status-message-text")
  };
}

for (const scriptPath of scriptPaths) {
  const label = path.relative(path.join(__dirname, ".."), scriptPath);

  test(`${label} shows the verified invitation message for READY_TO_SEND`, async () => {
    const result = await renderStatus(scriptPath, {
      paymentStatus: "VERIFIED",
      invitationStatus: "READY_TO_SEND"
    });

    assert.equal(result.message.hidden, false);
    assert.equal(result.message.classList.contains("status-message--success"), true);
    assert.equal(result.message.classList.contains("status-message--rejected"), false);
    assert.equal(result.icon.textContent, "✓");
    assert.equal(result.text.textContent, verifiedMessage);
  });

  test(`${label} displays the rejection reason and fallback`, async (t) => {
    await t.test("uses the admin-provided reason", async () => {
      const result = await renderStatus(scriptPath, {
        paymentStatus: "REJECTED",
        invitationStatus: "NOT_READY",
        rejectionReason: "  Screenshot is not readable.  "
      });

      assert.equal(result.message.hidden, false);
      assert.equal(result.message.classList.contains("status-message--rejected"), true);
      assert.equal(result.message.classList.contains("status-message--success"), false);
      assert.equal(result.icon.textContent, "!");
      assert.equal(result.text.textContent, "Screenshot is not readable.");
    });

    await t.test("uses the fallback when the reason is empty", async () => {
      const result = await renderStatus(scriptPath, {
        paymentStatus: "REJECTED",
        invitationStatus: "NOT_READY",
        rejectionReason: "  "
      });

      assert.equal(result.text.textContent, rejectionFallback);
    });
  });

  test(`${label} keeps the message area hidden while payment is pending`, async () => {
    const result = await renderStatus(scriptPath, {
      paymentStatus: "PENDING_VERIFICATION",
      invitationStatus: "NOT_READY"
    });

    assert.equal(result.message.hidden, true);
    assert.equal(result.message.classList.contains("status-message--success"), false);
    assert.equal(result.message.classList.contains("status-message--rejected"), false);
  });
}
