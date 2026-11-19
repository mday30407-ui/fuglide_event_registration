const adminApp = require("firebase-admin/app");
const adminFirestore = require("firebase-admin/firestore");
const adminStorage = require("firebase-admin/storage");

function createFirebase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId || projectId.trim() !== projectId) {
    throw new Error("FIREBASE_PROJECT_ID must be configured.");
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  let credential;
  if (serviceAccountJson || serviceAccountPath) {
    let account;
    try {
      account = serviceAccountJson
        ? JSON.parse(serviceAccountJson)
        : JSON.parse(require("node:fs").readFileSync(serviceAccountPath, "utf8"));
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid JSON or FIREBASE_SERVICE_ACCOUNT_PATH must point to it.");
    }
    if (!account.project_id || !account.client_email || !account.private_key ||
        account.project_id !== projectId) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is incomplete or mismatched.");
    }
    credential = adminApp.cert({
      ...account,
      private_key: account.private_key.replace(/\\n/g, "\n")
    });
  } else {
    credential = adminApp.applicationDefault();
  }

  let app = adminApp.getApps().find((candidate) => candidate.name === "[DEFAULT]");
  if (!app) app = adminApp.initializeApp({ credential, projectId });
  if (app.options.projectId && app.options.projectId !== projectId) {
    throw new Error("Initialized Firebase project does not match FIREBASE_PROJECT_ID.");
  }

  return {
    firestore: adminFirestore.getFirestore(app),
    storage: adminStorage.getStorage(app),
    bucketName: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.firebasestorage.app`
  };
}

module.exports = { createFirebase };
