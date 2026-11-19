const crypto = require("node:crypto");

function createStatusAccessToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashStatusAccessToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function matchesStatusAccessToken(token, expectedHash) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    return false;
  }
  const actual = Buffer.from(hashStatusAccessToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  createStatusAccessToken,
  hashStatusAccessToken,
  matchesStatusAccessToken
};
