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
    errorName: outcome === "failed"
      ? safeErrorName(
        stage === "firebase_store_initialization" ? rootCause(error) : error,
        stage === "firebase_store_initialization"
      )
      : null,
    errorMessage: stage === "firebase_store_initialization" && outcome === "failed"
      ? safeFirebaseErrorMessage(rootCause(error))
      : SAFE_MESSAGES[stage] && SAFE_MESSAGES[stage][outcome]
        ? SAFE_MESSAGES[stage][outcome]
        : "Registration request processing failed."
  };

  if (stage === "firebase_store_initialization" && outcome === "failed") {
    entry.errorClassification = safeFirebaseErrorClassification(error);
  }

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

function safeErrorName(error, preserveOriginal = false) {
  const name = error && typeof error.name === "string" ? error.name : "Error";
  return SAFE_ERROR_NAMES.has(name) ||
    (preserveOriginal && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
    ? name
    : "Error";
}

function rootCause(error) {
  let current = error;
  const visited = new Set();
  while (current && typeof current === "object" && current.cause &&
      !visited.has(current)) {
    visited.add(current);
    current = current.cause;
  }
  return current;
}

function safeFirebaseErrorClassification(error) {
  const classification = error && error.firebaseInitializationClassification;
  return typeof classification === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(classification)
    ? classification
    : "FIREBASE_INITIALIZATION_FAILED";
}

function safeFirebaseErrorMessage(error) {
  let message = error && typeof error.message === "string"
    ? error.message
    : "Unknown Firebase initialization error.";
  const sensitiveValues = [];

  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value &&
        /(?:^FIREBASE_|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL|RAZORPAY_KEY)/i.test(name)) {
      sensitiveValues.push(value);
    }
  }

  try {
    const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "null");
    if (account && typeof account === "object") {
      for (const value of Object.values(account)) {
        if (typeof value === "string" && value) sensitiveValues.push(value);
      }
    }
  } catch {
    // The malformed value itself is included above and is redacted as a whole.
  }

  sensitiveValues.sort((left, right) => right.length - left.length);
  for (const value of sensitiveValues) {
    message = message.split(value).join("[REDACTED]");
  }
  message = message
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._~-]+/g, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(
      /\b(private[_ -]?key|client[_ -]?email|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|credential|authorization|password)\s*[:=]\s*["']?[^,\s"'}`]+/gi,
      "$1=[REDACTED]"
    )
    .slice(0, 500);
  return message || "Unknown Firebase initialization error.";
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
