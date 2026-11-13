const { applicationDefault, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

function createDatabase() {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("FIREBASE_PROJECT_ID must be configured.");

  const app = getApps()[0] || initializeApp({
    credential: applicationDefault(),
    projectId
  });
  return getFirestore(app);
}

module.exports = { createDatabase };