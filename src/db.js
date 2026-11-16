function createDatabase(dependencies = {}) {
  const { applicationDefault, cert, getApps, initializeApp } =
    dependencies.appSdk || require("firebase-admin/app");
  const { getFirestore } = dependencies.firestoreSdk || require("firebase-admin/firestore");
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId || projectId.trim() !== projectId) {
    throw initializationError(
      "FIREBASE_PROJECT_ID_INVALID",
      "FIREBASE_PROJECT_ID must be configured as a non-empty project ID."
    );
  }

  const existingApp = getApps().find((candidate) => candidate.name === "[DEFAULT]");
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  let credential;

  if (serviceAccountJson) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch (error) {
      throw initializationError(
        "FIREBASE_SERVICE_ACCOUNT_JSON_INVALID",
        "FIREBASE_SERVICE_ACCOUNT must contain valid JSON.",
        error
      );
    }

    if (!serviceAccount || typeof serviceAccount !== "object" ||
        Array.isArray(serviceAccount) ||
        typeof serviceAccount.client_email !== "string" ||
        !serviceAccount.client_email.trim() ||
        typeof serviceAccount.private_key !== "string" ||
        !serviceAccount.private_key.trim() ||
        typeof serviceAccount.project_id !== "string" ||
        !serviceAccount.project_id.trim()) {
      throw initializationError(
        "FIREBASE_SERVICE_ACCOUNT_INVALID",
        "FIREBASE_SERVICE_ACCOUNT must contain project_id, client_email, and private_key."
      );
    }
    if (serviceAccount.project_id !== projectId) {
      throw initializationError(
        "FIREBASE_PROJECT_ID_MISMATCH",
        "FIREBASE_SERVICE_ACCOUNT does not match FIREBASE_PROJECT_ID."
      );
    }

    try {
      credential = cert({
        ...serviceAccount,
        private_key: serviceAccount.private_key.replace(/\\n/g, "\n")
      });
    } catch (error) {
      throw initializationError(
        "FIREBASE_CREDENTIAL_INVALID",
        "Firebase Admin rejected the service-account credentials.",
        error
      );
    }
  } else {
    try {
      credential = applicationDefault();
    } catch (error) {
      throw initializationError(
        "FIREBASE_APPLICATION_DEFAULT_CREDENTIAL_FAILED",
        "Firebase Application Default Credentials could not be loaded.",
        error
      );
    }
  }

  let app = existingApp;
  if (!app) {
    try {
      app = initializeApp({ credential, projectId });
    } catch (error) {
      throw initializationError(
        "FIREBASE_APP_INITIALIZATION_FAILED",
        "Firebase Admin could not initialize the default app.",
        error
      );
    }
  }
  if (app.options.projectId && app.options.projectId !== projectId) {
    throw initializationError(
      "FIREBASE_APP_PROJECT_ID_MISMATCH",
      "The initialized Firebase app does not match FIREBASE_PROJECT_ID."
    );
  }
  try {
    return getFirestore(app);
  } catch (error) {
    throw initializationError(
      "FIRESTORE_INITIALIZATION_FAILED",
      "Firebase Admin could not initialize Firestore.",
      error
    );
  }
}

function initializationError(classification, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.firebaseInitializationClassification = classification;
  return error;
}

module.exports = { createDatabase };