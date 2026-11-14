const loggedErrors = new WeakSet();

const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "Error",
  "FirebaseAppError",
  "FirebaseError",
  "FirebaseFirestoreError",
  "FirestoreError",
  "GoogleError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "ValidationError"
]);

const SAFE_MESSAGES = {
  registration_validation: {
    completed: "Registration validation completed.",
    failed: "Registration validation failed."
  },
  razorpay_configuration: {
    completed: "Razorpay configuration accepted.",
    failed: "Razorpay configuration rejected."
  },
  firebase_store_initialization: {
    completed: "Firebase registration store is ready.",
    failed: "Firebase registration store initialization failed."
  },
  firestore_registration_lookup: {
    started: "Firestore registration lookup started.",
    completed: "Firestore registration lookup completed.",
    failed: "Firestore registration lookup failed."
  },
  firestore_order_processing: {
    completed: "Firestore payment-order processing completed.",
    failed: "Firestore payment-order processing failed."
  },
  razorpay_order_creation: {
    started: "Razorpay order creation started.",
    completed: "Razorpay order creation completed.",
    failed: "Razorpay order creation failed."
  }
};

function logRequestDiagnostic(requestId, stage, outcome, error, details) {
  const entry = {
    requestId: typeof requestId === "string" ? requestId : null,
    stage,
    outcome,
    errorName: outcome === "failed" ? safeErrorName(error) : null,
    errorMessage: SAFE_MESSAGES[stage] && SAFE_MESSAGES[stage][outcome]
      ? SAFE_MESSAGES[stage][outcome]
      : "Registration request processing failed."
  };

  if (stage === "razorpay_configuration" && details) {
    for (const key of [
      "modeAccepted",
      "keyIdPresent",
      "keyIdPrefixMatchesMode",
      "keySecretPresent"
    ]) {
      if (typeof details[key] === "boolean") entry[key] = details[key];
    }
  }

  if (error && (typeof error === "object" || typeof error === "function")) {
    loggedErrors.add(error);
  }

  const logger = outcome === "failed" ? console.error : console.info;
  logger("Registration API diagnostic:", entry);
}

function safeErrorName(error) {
  const name = error && typeof error.name === "string" ? error.name : "Error";
  return SAFE_ERROR_NAMES.has(name) ? name : "Error";
}

function hasLoggedDiagnostic(error) {
  return Boolean(error && (typeof error === "object" || typeof error === "function") &&
    loggedErrors.has(error));
}

function markDiagnosticLogged(error) {
  if (error && (typeof error === "object" || typeof error === "function")) {
    loggedErrors.add(error);
  }
}

module.exports = {
  hasLoggedDiagnostic,
  logRequestDiagnostic,
  markDiagnosticLogged
};
