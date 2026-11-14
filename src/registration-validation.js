
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

const GENDERS = [
  "Female",
  "Male",
  "Non-binary",
  "Prefer not to say",
  "Other"
];

const REGISTRATION_FEE = 250;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

function boundedString(value, field, maxLength, required = true) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) {
      return "";
    }
    throw new ValidationError(`${field} is invalid.`);
  }

  const cleaned = value.trim();

  if (required && !cleaned) {
    throw new ValidationError(`${field} is required.`);
  }

  if (cleaned.length > maxLength) {
    throw new ValidationError(`${field} is too long.`);
  }

  return cleaned;
}

function validateRegistration(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("Registration details are required.");
  }

  const fullName = boundedString(input.fullName, "Full name", 120);
  const email = boundedString(input.email, "Email address", 254).toLowerCase();
  const mobile = boundedString(input.mobile, "Mobile number", 20);
  const gender = boundedString(input.gender, "Gender", 60, false);
  const city = boundedString(input.city, "City", 100);
  const organization = boundedString(input.organization, "College / organization name", 160);
  const designation = boundedString(input.designation, "Designation / course", 120);
  const participantCategory = boundedString(input.participantCategory, "Participant category", 80);
  const participationType = boundedString(input.participationType, "Participation type", 40);
  const message = boundedString(input.message, "Additional message", 1000, false);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("Enter a valid email address.");
  }

  const digits = mobile.replace(/\D/g, "");

  if (!/^\+?[0-9\s().-]+$/.test(mobile) ||
      digits.length < 10 ||
      digits.length > 15) {
    throw new ValidationError("Enter a valid mobile number.");
  }

  if (gender && !GENDERS.includes(gender)) {
    throw new ValidationError("Select a valid gender.");
  }

  if (!PARTICIPANT_CATEGORIES.includes(participantCategory)) {
    throw new ValidationError("Select a valid participant category.");
  }

  if (!PARTICIPATION_TYPES.includes(participationType)) {
    throw new ValidationError("Select a valid participation type.");
  }

  return {
    fullName,
    email,
    mobile,
    gender,
    city,
    organization,
    designation,
    participantCategory,
    participationType,
    message,
    registrationFee: REGISTRATION_FEE,
    currency: "INR"
  };
}

module.exports = {
  GENDERS,
  PARTICIPANT_CATEGORIES,
  PARTICIPATION_TYPES,
  REGISTRATION_FEE,
  ValidationError,
  validateRegistration
};
