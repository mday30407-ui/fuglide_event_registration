const test = require("node:test");
const assert = require("node:assert/strict");
const { escapeCsvField } = require("../src/admin-auth");

test("quotes normal CSV text, commas, and double quotes", () => {
  assert.equal(escapeCsvField("Asha Rao"), '"Asha Rao"');
  assert.equal(escapeCsvField("Pune, India"), '"Pune, India"');
  assert.equal(escapeCsvField('A "quoted" value'), '"A ""quoted"" value"');
});

test("prefixes formula-like CSV values with a single quote", () => {
  assert.equal(escapeCsvField("=SUM(1+1)"), `"'=SUM(1+1)"`);
  assert.equal(escapeCsvField("+123456"), `"'+123456"`);
  assert.equal(escapeCsvField("-123456"), `"'-123456"`);
  assert.equal(escapeCsvField("@SUM(A1:A2)"), `"'@SUM(A1:A2)"`);
});

test("detects formula markers after leading whitespace and control characters", () => {
  assert.equal(escapeCsvField("  =SUM(1+1)"), `"'  =SUM(1+1)"`);
  assert.equal(escapeCsvField("\t+123456"), `"'\t+123456"`);
  assert.equal(escapeCsvField("\r\n-123456"), `"'\r\n-123456"`);
});
