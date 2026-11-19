const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createStorageAdapter,
  InvalidScreenshotPathError,
  ScreenshotConfigurationError,
  ScreenshotNotFoundError,
  parseScreenshotPath
} = require("../src/manual-storage");

const registrationId = "FD26-M-000000000001";
const legacyObjectPath =
  `manual-payment-screenshots/${registrationId}/00000000-0000-4000-8000-000000000001.png`;
const objectPath = `supabase/${legacyObjectPath}`;
const storedPath = objectPath;
const screenshot = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function createSupabaseClient({ onUpload, onDownload, onRemove, onGetBucket } = {}) {
  const calls = { uploads: [], downloads: [], removals: [], bucketChecks: [] };
  const client = {
    storage: {
      async getBucket(bucketName) {
        calls.bucketChecks.push(bucketName);
        return onGetBucket
          ? onGetBucket(bucketName)
          : { data: { public: false }, error: null };
      },
      from(bucketName) {
        calls.bucketName = bucketName;
        return {
          async upload(filePath, data, options) {
            calls.uploads.push({ filePath, data, options });
            return onUpload ? onUpload(filePath, data, options) : { error: null };
          },
          async download(filePath) {
            calls.downloads.push(filePath);
            return onDownload
              ? onDownload(filePath)
              : { data: new Blob([screenshot]), error: null };
          },
          async remove(filePaths) {
            calls.removals.push(filePaths);
            return onRemove ? onRemove(filePaths) : { data: [], error: null };
          }
        };
      }
    }
  };
  return { client, calls };
}

test("uploads uniquely named screenshots to the configured private bucket", async () => {
  const { client, calls } = createSupabaseClient();
  const storage = createStorageAdapter({
    mode: "firebase",
    supabaseClient: client,
    environment: { SUPABASE_STORAGE_BUCKET: "payment-screenshots" }
  });

  const firstPath = await storage.saveScreenshot(registrationId, {
    buffer: screenshot,
    mimetype: "image/png"
  });
  const secondPath = await storage.saveScreenshot(registrationId, {
    buffer: screenshot,
    mimetype: "image/png"
  });

  assert.match(firstPath, /^supabase\/manual-payment-screenshots\/FD26-M-000000000001\/.+\.png$/);
  assert.notEqual(firstPath, secondPath);
  assert.equal(calls.bucketName, "payment-screenshots");
  assert.deepEqual(calls.bucketChecks, ["payment-screenshots", "payment-screenshots"]);
  assert.equal(calls.uploads[0].filePath, firstPath);
  assert.equal(calls.uploads[0].options.contentType, "image/png");
  assert.equal(calls.uploads[0].options.upsert, false);
  assert.deepEqual(calls.uploads[0].data, screenshot);
});

test("reports missing Supabase configuration without exposing credentials", async () => {
  let factoryCalled = false;
  const storage = createStorageAdapter({
    environment: {},
    supabaseClientFactory() {
      factoryCalled = true;
      assert.fail("The SDK must not initialize with missing configuration.");
    }
  });

  await assert.rejects(
    storage.saveScreenshot(registrationId, { buffer: screenshot, mimetype: "image/png" }),
    (error) => {
      assert.ok(error instanceof ScreenshotConfigurationError);
      assert.match(error.message, /SUPABASE_URL/);
      assert.match(error.message, /SUPABASE_SERVICE_ROLE_KEY/);
      assert.match(error.message, /SUPABASE_STORAGE_BUCKET/);
      assert.doesNotMatch(error.message, /secret|key-value/i);
      return true;
    }
  );
  assert.equal(factoryCalled, false);
});

test("initializes the SDK from server environment values with persistence disabled", async () => {
  const { client } = createSupabaseClient();
  const captured = {};
  const serviceRoleKey = "server-only-test-key";
  const storage = createStorageAdapter({
    environment: {
      SUPABASE_URL: "https://project-id.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_STORAGE_BUCKET: "payment-screenshots"
    },
    supabaseClientFactory(url, key, options) {
      captured.url = url;
      captured.key = key;
      captured.options = options;
      return client;
    }
  });

  await storage.saveScreenshot(registrationId, {
    buffer: screenshot,
    mimetype: "image/png"
  });

  assert.equal(captured.url, "https://project-id.supabase.co");
  assert.equal(captured.key, serviceRoleKey);
  assert.deepEqual(captured.options.auth, {
    autoRefreshToken: false,
    detectSessionInUrl: false,
    persistSession: false
  });

  const retrievalStorage = createStorageAdapter({
    environment: {
      SUPABASE_URL: "https://project-id.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      SUPABASE_STORAGE_BUCKET: "payment-screenshots"
    },
    supabaseClientFactory: () => client
  });
  assert.deepEqual(await retrievalStorage.getScreenshot(storedPath), screenshot);
});

test("downloads and deletes only the requested Supabase object", async () => {
  const { client, calls } = createSupabaseClient();
  const storage = createStorageAdapter({
    supabaseClient: client,
    environment: { SUPABASE_STORAGE_BUCKET: "payment-screenshots" }
  });

  assert.deepEqual(await storage.getScreenshot(storedPath), screenshot);
  await storage.deleteScreenshot(storedPath);

  assert.deepEqual(calls.downloads, [objectPath]);
  assert.deepEqual(calls.removals, [[objectPath]]);
});

test("refuses to upload or retrieve files when the configured bucket is public", async () => {
  const { client, calls } = createSupabaseClient({
    onGetBucket: async () => ({ data: { public: true }, error: null })
  });
  const storage = createStorageAdapter({
    supabaseClient: client,
    environment: { SUPABASE_STORAGE_BUCKET: "payment-screenshots" }
  });

  await assert.rejects(
    storage.saveScreenshot(registrationId, {
      buffer: screenshot,
      mimetype: "image/png"
    }),
    (error) => error.code === "SUPABASE_BUCKET_NOT_PRIVATE"
  );
  await assert.rejects(
    storage.getScreenshot(storedPath),
    (error) => error.code === "SUPABASE_BUCKET_NOT_PRIVATE"
  );
  assert.deepEqual(calls.uploads, []);
  assert.deepEqual(calls.downloads, []);
});

test("rejects malformed or traversing screenshot paths before storage access", async () => {
  const { client, calls } = createSupabaseClient();
  const storage = createStorageAdapter({
    supabaseClient: client,
    environment: { SUPABASE_STORAGE_BUCKET: "payment-screenshots" }
  });

  for (const invalidPath of [
    "../private/key.png",
    `supabase/${legacyObjectPath.replace(registrationId, "FD26-M-../../")}`,
    `supabase/${legacyObjectPath.replace(".png", ".svg")}`,
    storedPath.replace("supabase/", "supabase//")
  ]) {
    await assert.rejects(
      storage.getScreenshot(invalidPath),
      InvalidScreenshotPathError
    );
  }
  assert.deepEqual(calls.downloads, []);
});

test("falls back to legacy local files when the configured Firebase object is absent", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fuglide-storage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, ...legacyObjectPath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, screenshot);

  const firebaseStorage = {
    bucket() {
      return {
        file() {
          return {
            async download() {
              const error = new Error("not found");
              error.code = "storage/object-not-found";
              throw error;
            }
          };
        }
      };
    }
  };
  const storage = createStorageAdapter({
    storage: firebaseStorage,
    bucketName: "legacy-bucket",
    mode: "firebase",
    environment: {
      MANUAL_PAYMENT_UPLOAD_DIR: directory
    }
  });

  assert.deepEqual(await storage.getScreenshot(legacyObjectPath), screenshot);
});

test("falls back to the legacy Firebase bucket when the local file is absent", async () => {
  const firebaseStorage = {
    bucket() {
      return {
        file(filePath) {
          assert.equal(filePath, legacyObjectPath);
          return { download: async () => [screenshot] };
        }
      };
    }
  };
  const storage = createStorageAdapter({
    storage: firebaseStorage,
    bucketName: "legacy-bucket",
    mode: "local",
    environment: {
      MANUAL_PAYMENT_UPLOAD_DIR: path.join(os.tmpdir(), "missing-fuglide-storage")
    }
  });

  assert.deepEqual(await storage.getScreenshot(legacyObjectPath), screenshot);
});

test("rejects paths that do not match the stored screenshot convention", () => {
  assert.throws(() => parseScreenshotPath("supabase/manual-payment-screenshots/a/file.png"),
    InvalidScreenshotPathError);
  assert.throws(() => parseScreenshotPath("manual-payment-screenshots/../file.png"),
    InvalidScreenshotPathError);
  assert.throws(() => parseScreenshotPath("manual-payment-screenshots/FD26-M-000000000001/not-a-uuid.png"),
    InvalidScreenshotPathError);
});

test("maps missing Supabase objects to a not-found condition", async () => {
  const { client } = createSupabaseClient({
    onDownload: async () => ({
      data: null,
      error: { statusCode: "404", code: "not_found" }
    })
  });
  const storage = createStorageAdapter({
    supabaseClient: client,
    environment: { SUPABASE_STORAGE_BUCKET: "payment-screenshots" }
  });

  await assert.rejects(storage.getScreenshot(storedPath), ScreenshotNotFoundError);
});
