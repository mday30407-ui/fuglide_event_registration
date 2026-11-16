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

test("classifies malformed service-account JSON and retains its parser exception", () => {
  withEnvironment({
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT: "{\"private_key\":"
  }, () => {
    let thrown;
    try {
      createDatabase({
        appSdk: {
          applicationDefault: () => ({}),
          cert: () => ({}),
          getApps: () => [],
          initializeApp: () => ({ options: {} })
        },
        firestoreSdk: { getFirestore: () => ({}) }
      });
    } catch (error) {
      thrown = error;
    }

    assert.equal(thrown.firebaseInitializationClassification, "FIREBASE_SERVICE_ACCOUNT_JSON_INVALID");
    assert.equal(thrown.cause.name, "SyntaxError");
  });
});

test("classifies an invalid private key while retaining Firebase Admin's exception", () => {
  withEnvironment({
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "test-project",
      client_email: "service@example.invalid",
      private_key: "invalid-private-key"
    })
  }, () => {
    const originalError = new Error("Invalid private key: invalid-private-key");
    assert.throws(() => createDatabase({
      appSdk: {
        applicationDefault: () => ({}),
        cert: () => { throw originalError; },
        getApps: () => [],
        initializeApp: () => ({ options: {} })
      },
      firestoreSdk: { getFirestore: () => ({}) }
    }), (error) => {
      assert.equal(error.firebaseInitializationClassification, "FIREBASE_CREDENTIAL_INVALID");
      assert.equal(error.cause, originalError);
      return true;
    });
  });
});

test("rejects a service-account project ID that does not match configuration", () => {
  withEnvironment({
    FIREBASE_PROJECT_ID: "configured-project",
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      project_id: "account-project",
      client_email: "service@example.invalid",
      private_key: "private-key"
    })
  }, () => {
    assert.throws(() => createDatabase({
      appSdk: {
        applicationDefault: () => ({}),
        cert: () => assert.fail("A mismatched account must not be passed to cert."),
        getApps: () => [],
        initializeApp: () => ({ options: {} })
      },
      firestoreSdk: { getFirestore: () => ({}) }
    }), (error) => {
      assert.equal(error.firebaseInitializationClassification, "FIREBASE_PROJECT_ID_MISMATCH");
      return true;
    });
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
