const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createRegistrationRouter } = require("../src/manual-registration-routes");
const { createStorageAdapter } = require("../src/manual-storage");

const registration = {
  fullName: "Asha Rao",
  email: "asha@example.test",
  mobile: "+91 9876543210",
  city: "Pune",
  college: "Example College",
  participantCategory: "College / University Student",
  participationType: "Event Attendee",
  utrNumber: "UPI12345678"
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function createMemoryFirestore({ failRegistrationUpdate = false, failRollback = false } = {}) {
  const collections = new Map();
  let transactionCount = 0;
  const collectionData = (name) => {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  };
  const ref = (collectionName, id) => ({
    collectionName,
    id,
    async get() {
      const value = collectionData(collectionName).get(id);
      return { exists: value !== undefined, data: () => value && structuredClone(value) };
    },
    async update(value) {
      if (failRegistrationUpdate && collectionName === "manual_payment_registrations") {
        throw new Error("Injected Firestore update failure.");
      }
      const current = collectionData(collectionName).get(id);
      if (!current) throw new Error("Document does not exist.");
      collectionData(collectionName).set(id, { ...current, ...structuredClone(value) });
    }
  });
  return {
    collection(name) {
      return { doc: (id) => ref(name, id) };
    },
    async runTransaction(callback) {
      transactionCount += 1;
      if (failRollback && transactionCount > 1) {
        const error = new Error("Injected rollback failure.");
        error.code = "unavailable";
        throw error;
      }
      const writes = [];
      const transaction = {
        async get(documentRef) {
          return documentRef.get();
        },
        create(documentRef, value) {
          writes.push({ type: "create", documentRef, value: structuredClone(value) });
        },
        delete(documentRef) {
          writes.push({ type: "delete", documentRef });
        }
      };
      const result = await callback(transaction);
      for (const write of writes) {
        const collection = collectionData(write.documentRef.collectionName);
        if (write.type === "create" && collection.has(write.documentRef.id)) {
          const error = new Error("Document already exists.");
          error.code = "already-exists";
          throw error;
        }
      }
      for (const write of writes) {
        const collection = collectionData(write.documentRef.collectionName);
        if (write.type === "delete") collection.delete(write.documentRef.id);
        else collection.set(write.documentRef.id, write.value);
      }
      return result;
    },
    entries(name) {
      return [...collectionData(name).entries()];
    }
  };
}

function createSupabaseStorage(options = {}) {
  const objects = new Map();
  const calls = { uploads: [], removals: [] };
  const client = {
    storage: {
      async getBucket() {
        return { data: { public: false }, error: null };
      },
      from(bucketName) {
        calls.bucketName = bucketName;
        return {
          async upload(objectPath, body, uploadOptions) {
            calls.uploads.push({ objectPath, body, uploadOptions });
            if (options.uploadError) return { error: options.uploadError };
            if (!uploadOptions.upsert && objects.has(objectPath)) {
              return { error: { statusCode: "409", code: "Duplicate" } };
            }
            objects.set(objectPath, Buffer.from(body));
            return { error: null };
          },
          async download(objectPath) {
            const body = objects.get(objectPath);
            return body
              ? { data: new Blob([body]), error: null }
              : { data: null, error: { statusCode: "404", code: "not_found" } };
          },
          async remove(objectPaths) {
            calls.removals.push(objectPaths);
            for (const objectPath of objectPaths) objects.delete(objectPath);
            return { data: [], error: null };
          }
        };
      }
    }
  };
  const adapter = createStorageAdapter({
    supabaseClient: client,
    environment: { SUPABASE_STORAGE_BUCKET: "payment-screenshots" }
  });
  return { adapter, calls, objects };
}

function makeForm(fileBytes = png, mimeType = "image/png") {
  const form = new FormData();
  for (const [key, value] of Object.entries(registration)) form.set(key, value);
  form.set("paymentScreenshot", new Blob([fileBytes], { type: mimeType }), "payment.png");
  return form;
}

async function withRegistrationServer(callback, { database, storage }) {
  const app = express();
  app.use("/api", createRegistrationRouter({ firestore: database, storage }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(address);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("saves a Supabase path with the Firestore registration and preserves duplicate protection", async () => {
  const database = createMemoryFirestore();
  const supabase = createSupabaseStorage();

  await withRegistrationServer(async (address) => {
    const response = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm()
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    const [registrationId, savedRegistration] =
      database.entries("manual_payment_registrations")[0];
    const screenshotPath = savedRegistration.paymentScreenshotStoragePath;
    assert.equal(savedRegistration.registrationId, registrationId);
    assert.match(screenshotPath, new RegExp(`^supabase/manual-payment-screenshots/${registrationId}/`));
    assert.equal(supabase.objects.has(screenshotPath), true);
    assert.equal(savedRegistration.amount, 100);
    assert.equal(result.registrationId, registrationId);

    const duplicate = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm()
    });
    assert.equal(duplicate.status, 409);
    assert.equal(supabase.calls.uploads.length, 1);
    assert.equal(database.entries("manual_payment_registrations").length, 1);
    assert.equal(database.entries("manual_payment_duplicate_locks").length, 1);
  }, { database, storage: supabase.adapter });
});

test("rejects invalid image signatures and files over five megabytes before saving", async () => {
  const database = createMemoryFirestore();
  const supabase = createSupabaseStorage();

  await withRegistrationServer(async (address) => {
    const invalidImage = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm(Buffer.from("not an image"), "image/png")
    });
    assert.equal(invalidImage.status, 400);

    const invalidMime = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm(png, "image/gif")
    });
    assert.equal(invalidMime.status, 400);

    const oversizedImage = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm(Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))
    });
    assert.equal(oversizedImage.status, 413);
    assert.equal(supabase.calls.uploads.length, 0);
    assert.equal(database.entries("manual_payment_registrations").length, 0);
  }, { database, storage: supabase.adapter });
});

test("rolls back Firestore and removes only the screenshot if the Firestore path update fails", async () => {
  const database = createMemoryFirestore({ failRegistrationUpdate: true });
  const supabase = createSupabaseStorage();

  await withRegistrationServer(async (address) => {
    const response = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm()
    });
    assert.equal(response.status, 500);
    assert.equal(database.entries("manual_payment_registrations").length, 0);
    assert.equal(database.entries("manual_payment_duplicate_locks").length, 0);
    assert.equal(supabase.objects.size, 0);
    assert.equal(supabase.calls.removals.length, 1);
    assert.equal(supabase.calls.removals[0][0], supabase.calls.uploads[0].objectPath);
  }, { database, storage: supabase.adapter });
});

test("keeps the object and logs its path when the Firestore rollback itself fails", async () => {
  const database = createMemoryFirestore({
    failRegistrationUpdate: true,
    failRollback: true
  });
  const supabase = createSupabaseStorage();
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);

  try {
    await withRegistrationServer(async (address) => {
      const response = await fetch(`${address}/api/registrations`, {
        method: "POST",
        body: makeForm()
      });
      assert.equal(response.status, 500);
      assert.equal(database.entries("manual_payment_registrations").length, 1);
      assert.equal(supabase.objects.size, 1);
      assert.equal(supabase.calls.removals.length, 0);
    }, { database, storage: supabase.adapter });
  } finally {
    console.error = originalError;
  }

  const diagnostic = JSON.stringify(errors);
  assert.match(diagnostic, /firestore_rollback/);
  assert.match(diagnostic, /supabase\/manual-payment-screenshots\/FD26-M-/);
  assert.doesNotMatch(diagnostic, /UPI12345678|asha@example\.test|service_role|SUPABASE_SERVICE_ROLE_KEY/);
});

test("cleans up an upload failure and does not create a registration", async () => {
  const database = createMemoryFirestore();
  const supabase = createSupabaseStorage({
    uploadError: { statusCode: "503", code: "StorageUnavailable" }
  });

  await withRegistrationServer(async (address) => {
    const response = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm()
    });
    assert.equal(response.status, 500);
    assert.equal(database.entries("manual_payment_registrations").length, 0);
    assert.equal(database.entries("manual_payment_duplicate_locks").length, 0);
    assert.equal(supabase.objects.size, 0);
    assert.equal(supabase.calls.removals.length, 1);
  }, { database, storage: supabase.adapter });
});

test("returns a clear non-success response and rolls back when Supabase configuration is missing", async () => {
  const database = createMemoryFirestore();
  const storage = createStorageAdapter({ environment: {} });

  await withRegistrationServer(async (address) => {
    const response = await fetch(`${address}/api/registrations`, {
      method: "POST",
      body: makeForm()
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "Payment screenshot storage is not configured.");
    assert.equal(database.entries("manual_payment_registrations").length, 0);
    assert.equal(database.entries("manual_payment_duplicate_locks").length, 0);
  }, { database, storage });
});
