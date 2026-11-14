const test = require("node:test");
const assert = require("node:assert/strict");
const { createDatabase } = require("../src/db");

function withEnvironment(values, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("initializes Firebase Admin from the Vercel service-account environment variable", () => {
  withEnvironment({
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "test-project",
      client_email: "service@example.invalid",
      private_key: "test-private-key\\nline-two"
    })
  }, () => {
    let appOptions;
    let suppliedAccount;
    const app = { name: "[DEFAULT]", options: { projectId: "test-project" } };
    const database = { firestore: true };
    const result = createDatabase({
      appSdk: {
        applicationDefault() {
          assert.fail("ADC must not be used when service-account credentials are configured.");
        },
        cert(account) {
          suppliedAccount = account;
          return { serviceAccount: true };
        },
        getApps: () => [],
        initializeApp(options) {
          appOptions = options;
          return app;
        }
      },
      firestoreSdk: {
        getFirestore(initializedApp) {
          assert.equal(initializedApp, app);
          return database;
        }
      }
    });

    assert.equal(result, database);
    assert.equal(appOptions.projectId, "test-project");
    assert.equal(suppliedAccount.private_key, "test-private-key\nline-two");
  });
});

test("uses Application Default Credentials when no service account is configured", () => {
  withEnvironment({
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT: undefined
  }, () => {
    let initializedCredential;
    const app = { name: "[DEFAULT]", options: { projectId: "test-project" } };
    const credential = { applicationDefault: true };
    createDatabase({
      appSdk: {
        applicationDefault: () => credential,
        cert: () => assert.fail("A service-account certificate is not expected."),
        getApps: () => [],
        initializeApp(options) {
          initializedCredential = options.credential;
          return app;
        }
      },
      firestoreSdk: { getFirestore: () => ({}) }
    });

    assert.equal(initializedCredential, credential);
  });
});

test("fails clearly when the Firebase project ID is missing", () => {
  withEnvironment({
    FIREBASE_PROJECT_ID: undefined,
    FIREBASE_SERVICE_ACCOUNT: undefined
  }, () => {
    assert.throws(() => createDatabase({
      appSdk: {
        applicationDefault: () => ({}),
        cert: () => ({}),
        getApps: () => [],
        initializeApp: () => ({})
      },
      firestoreSdk: { getFirestore: () => ({}) }
    }), /FIREBASE_PROJECT_ID must be configured/);
  });
});

test("reuses the existing default Firebase Admin app", () => {
  const app = { name: "[DEFAULT]", options: { projectId: "test-project" } };
  withEnvironment({
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT: undefined
  }, () => {
    const database = { firestore: true };
    const result = createDatabase({
      appSdk: {
        applicationDefault: () => ({}),
        cert: () => ({}),
        getApps: () => [app],
        initializeApp: () => assert.fail("Firebase Admin must not initialize twice.")
      },
      firestoreSdk: {
        getFirestore(initializedApp) {
          assert.equal(initializedApp, app);
          return database;
        }
      }
    });
    assert.equal(result, database);
  });
});
