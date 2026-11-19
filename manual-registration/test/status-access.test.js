const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createStatusAccessToken,
  hashStatusAccessToken,
  matchesStatusAccessToken
} = require("../src/status-access");

test("status access tokens are random, URL-safe, and validated against stored hashes", () => {
  const token = createStatusAccessToken();
  const hash = hashStatusAccessToken(token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(matchesStatusAccessToken(token, hash), true);
  assert.equal(matchesStatusAccessToken(`${token}x`, hash), false);
  assert.equal(matchesStatusAccessToken(token, "invalid"), false);
});
