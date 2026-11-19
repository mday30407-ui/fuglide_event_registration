const crypto = require("node:crypto");

const PARTICIPANT_CATEGORIES = [
  "College / University Student",
  "Young Entrepreneur / Startup",
  "Industry Leader / Business Owner",
  "Educator / Innovation Mentor",
  "Investor / Ecosystem Partner"
];

const PARTICIPATION_TYPES = [
  "Event Attendee",
  "Sponsor",
  "Business Stall",
  "Brand Publishing"
];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function cleanString(value, name, max, required = true) {
  if (typeof value !== "string") {
    if (!required) return "";
    throw new ValidationError(`${name} is required.`);
  }
  const result = value.trim();
  if (required && !result) throw new ValidationError(`${name} is required.`);
  if (result.length > max) throw new ValidationError(`${name} is too long.`);
  return result;
}

function validateRegistration(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Registration details are required.");
  }
  const fullName = cleanString(body.fullName, "Full name", 120);
  const email = cleanString(body.email, "Email address", 254).toLowerCase();
  const mobile = cleanString(body.mobile, "Mobile number", 20);
  const city = cleanString(body.city, "City", 100);
  const college = cleanString(body.college, "College / organization", 160);
  const participantCategory = cleanString(body.participantCategory, "Participant category", 80);
  const participationType = cleanString(body.participationType, "Participation type", 40);
  const utrNumber = cleanString(body.utrNumber, "UPI transaction ID / UTR", 100);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("Enter a valid email address.");
  const digits = mobile.replace(/\D/g, "");
  if (!/^\+?[0-9\s().-]+$/.test(mobile) || digits.length < 10 || digits.length > 15) {
    throw new ValidationError("Enter a valid mobile number.");
  }
  if (!PARTICIPANT_CATEGORIES.includes(participantCategory)) {
    throw new ValidationError("Select a valid participant category.");
  }
  if (!PARTICIPATION_TYPES.includes(participationType)) {
    throw new ValidationError("Select a valid participation type.");
  }
  if (!/^[A-Za-z0-9-]{6,100}$/.test(utrNumber)) {
    throw new ValidationError("Enter a valid UPI transaction ID / UTR number.");
  }

  return { fullName, email, mobile, city, college, participantCategory, participationType, utrNumber };
}

function validateImage(buffer, mimeType) {
  const allowedMime = new Set(["image/jpeg", "image/png", "image/webp"]);
  if (!allowedMime.has(mimeType)) throw new ValidationError("Upload a JPG, PNG, or WebP image.");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
    throw new ValidationError("The payment screenshot must be 5 MB or smaller.");
  }

  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!jpeg && !png && !webp) throw new ValidationError("The uploaded file is not a valid image.");
  if (jpeg && mimeType !== "image/jpeg") throw new ValidationError("The uploaded file type does not match.");
  if (png && mimeType !== "image/png") throw new ValidationError("The uploaded file type does not match.");
  if (webp && mimeType !== "image/webp") throw new ValidationError("The uploaded file type does not match.");
  return true;
}

function duplicateKey(email, utrNumber) {
  return crypto.createHash("sha256").update(`${email.toLowerCase()}|${utrNumber.toUpperCase()}`).digest("hex");
}

module.exports = {
  PARTICIPANT_CATEGORIES,
  PARTICIPATION_TYPES,
  ValidationError,
  validateRegistration,
  validateImage,
  duplicateKey
};
