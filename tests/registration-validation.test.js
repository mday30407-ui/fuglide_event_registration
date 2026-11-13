const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REGISTRATION_FEE,
  ValidationError,
  validateRegistration
} = require("../src/registration-validation");

const validRegistration = {
  fullName: "Asha Rao",
  email: "ASHA@example.com",
  mobile: "+91 9876543210",
  gender: "",
  city: "Pune",
  organization: "Example College",
  designation: "Student",
  participantCategory: "College / University Student",
  participationType: "Event Attendee",
  message: ""
};

test("validates and normalizes registration details with a fixed fee", () => {
  const result = validateRegistration({ ...validRegistration, registrationFee: 1, currency: "USD" });
  assert.equal(result.email, "asha@example.com");
  assert.equal(result.registrationFee, 250);
  assert.equal(result.currency, "INR");
  assert.equal(REGISTRATION_FEE, 250);
});

test("rejects missing required fields and unsupported selection values", () => {
  assert.throws(() => validateRegistration({ ...validRegistration, fullName: " " }), ValidationError);
  assert.throws(() => validateRegistration({
    ...validRegistration,
    participantCategory: "Unlisted category"
  }), ValidationError);
});

test("rejects invalid email, mobile number, and oversized messages", () => {
  assert.throws(() => validateRegistration({ ...validRegistration, email: "invalid" }), ValidationError);
  assert.throws(() => validateRegistration({ ...validRegistration, mobile: "123" }), ValidationError);
  assert.throws(() => validateRegistration({ ...validRegistration, message: "x".repeat(1001) }), ValidationError);
});