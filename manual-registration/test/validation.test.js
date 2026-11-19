const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRegistration, validateImage, ValidationError } = require("../src/validation");

test("validates compatible participant and participation choices", () => {
  const result = validateRegistration({
    fullName: "Test Participant",
    email: "participant@example.com",
    mobile: "9876543210",
    city: "Dindigul",
    college: "Example Organization",
    participantCategory: "College / University Student",
    participationType: "Event Attendee",
    utrNumber: "ABC123456789"
  });
  assert.equal(result.amount, undefined);
  assert.equal(result.utrNumber, "ABC123456789");
});

test("rejects invalid UTR values", () => {
  const body = {
    fullName: "Test Participant", email: "participant@example.com", mobile: "9876543210",
    city: "Dindigul", college: "Example Organization",
    participantCategory: "College / University Student", participationType: "Event Attendee",
    utrNumber: "bad utr!"
  };
  assert.throws(() => validateRegistration(body), ValidationError);
});

test("rejects executable content disguised with an image MIME type", () => {
  assert.throws(
    () => validateImage(Buffer.from("#!/bin/sh"), "image/png"),
    /not a valid image/
  );
});

test("accepts valid JPEG header and rejects oversized content", () => {
  assert.doesNotThrow(() => validateImage(Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(100)
  ]), "image/jpeg"));
  assert.throws(() => validateImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/jpeg"),
    /5 MB/);
});
