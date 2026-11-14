function createDatabase(dependencies = {}) {
  const { applicationDefault, cert, getApps, initializeApp } =
    dependencies.appSdk || require("firebase-admin/app");
  const { getFirestore } = dependencies.firestoreSdk || require("firebase-admin/firestore");
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID must be configured.");

  const existingApp = getApps().find((candidate) => candidate.name === "[DEFAULT]");
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  let credential;

  if (serviceAccountJson) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(serviceAccountJson);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid JSON.");
    }

    if (!serviceAccount || typeof serviceAccount !== "object" ||
        typeof serviceAccount.client_email !== "string" ||
        typeof serviceAccount.private_key !== "string") {
      throw new Error("FIREBASE_SERVICE_ACCOUNT must contain client_email and private_key.");
    }
    if (serviceAccount.project_id && serviceAccount.project_id !== projectId) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT does not match FIREBASE_PROJECT_ID.");
    }

    credential = cert({
      ...serviceAccount,
      private_key: serviceAccount.private_key.replace(/\\n/g, "\n")
    });
  } else {
    credential = applicationDefault();
  }

  const app = existingApp || initializeApp({ credential, projectId });
  if (app.options.projectId && app.options.projectId !== projectId) {
    throw new Error("The initialized Firebase app does not match FIREBASE_PROJECT_ID.");
  }
  return getFirestore(app);
}

module.exports = { createDatabase };