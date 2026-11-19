const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const { createClient } = require("@supabase/supabase-js");

const SCREENSHOT_PREFIX = "manual-payment-screenshots/";
const SUPABASE_PREFIX = "supabase/";
const SCREENSHOT_PATH_PATTERN =
  /^manual-payment-screenshots\/FD26-M-[A-F0-9]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/;

class ScreenshotNotFoundError extends Error {
  constructor() {
    super("Payment screenshot is unavailable.");
    this.name = "ScreenshotNotFoundError";
    this.statusCode = 404;
  }
}

class ScreenshotConfigurationError extends Error {
  constructor(message, code = "SUPABASE_CONFIGURATION_INVALID") {
    super(message);
    this.name = "ScreenshotConfigurationError";
    this.statusCode = 503;
    this.code = code;
  }
}

class InvalidScreenshotPathError extends Error {
  constructor() {
    super("Invalid screenshot reference.");
    this.name = "InvalidScreenshotPathError";
    this.statusCode = 404;
  }
}

function createStorageAdapter({
  storage,
  bucketName,
  mode = process.env.MANUAL_PAYMENT_STORAGE || "firebase",
  supabaseClient,
  supabaseClientFactory = createClient,
  environment = process.env
}) {
  if (!["firebase", "local", "supabase"].includes(mode)) {
    throw new Error("MANUAL_PAYMENT_STORAGE must be firebase, local, or supabase.");
  }

  const legacyMode = mode === "local" ? "local" : "firebase";
  let cachedSupabaseClient = supabaseClient || null;
  let cachedSupabaseBucket = null;

  async function saveScreenshot(registrationId, file) {
    if (!/^FD26-M-[A-F0-9]{12}$/.test(registrationId)) {
      throw new Error("Invalid registration ID for screenshot storage.");
    }

    const extension = file.mimetype === "image/png" ? "png" :
      file.mimetype === "image/webp" ? "webp" : "jpg";
    const objectPath =
      `${SUPABASE_PREFIX}${SCREENSHOT_PREFIX}${registrationId}/${crypto.randomUUID()}.${extension}`;
    const storedPath = objectPath;
    const bucket = getSupabaseBucket();
    await assertSupabaseBucketIsPrivate();

    try {
      const { error } = await bucket.upload(objectPath, file.buffer, {
        contentType: file.mimetype,
        cacheControl: "0",
        upsert: false
      });
      if (error) throw createStorageOperationError(error, "upload");
      return storedPath;
    } catch (error) {
      if (error instanceof ScreenshotConfigurationError) throw error;

      try {
        const { error: cleanupError } = await bucket.remove([objectPath]);
        if (cleanupError && !isNotFound(cleanupError)) {
          throw cleanupError;
        }
      } catch (cleanupError) {
        if (!isNotFound(cleanupError)) {
          console.error("Supabase screenshot upload cleanup failed:", {
            registrationId,
            objectPath: storedPath,
            errorName: safeErrorName(cleanupError),
            errorCode: safeErrorCode(cleanupError)
          });
          const operationError = error instanceof Error
            ? error
            : createStorageOperationError(error, "upload");
          operationError.storagePath = storedPath;
          throw operationError;
        }
      }

      throw error instanceof Error
        ? error
        : createStorageOperationError(error, "upload");
    }
  }

  async function getScreenshot(storedPath) {
    const parsedPath = parseScreenshotPath(storedPath);
    if (parsedPath.provider === "supabase") {
      await assertSupabaseBucketIsPrivate();
      const { data, error } = await getSupabaseBucket().download(parsedPath.objectPath);
      if (error) throw createStorageOperationError(error, "download");
      if (!data) throw new ScreenshotNotFoundError();
      if (Buffer.isBuffer(data)) return data;
      if (typeof data.arrayBuffer === "function") {
        return Buffer.from(await data.arrayBuffer());
      }
      throw new Error("Supabase returned an unsupported screenshot response.");
    }

    return getLegacyScreenshot(parsedPath.objectPath);
  }

  async function deleteScreenshot(storedPath) {
    const parsedPath = parseScreenshotPath(storedPath);
    if (parsedPath.provider === "supabase") {
      const { error } = await getSupabaseBucket().remove([parsedPath.objectPath]);
      if (error && !isNotFound(error)) {
        throw createStorageOperationError(error, "delete");
      }
      return;
    }

    if (legacyMode === "local") {
      for (const destination of getLocalCandidates(parsedPath.objectPath)) {
        try {
          await fs.unlink(destination);
          return;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      return;
    }

    const bucket = getFirebaseBucket();
    try {
      await bucket.file(parsedPath.objectPath).delete({ ignoreNotFound: true });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  function getSupabaseBucket() {
    if (!cachedSupabaseClient) {
      const url = environment.SUPABASE_URL;
      const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
      const configuredBucketName = environment.SUPABASE_STORAGE_BUCKET;

      if (!url || !url.trim() || !serviceRoleKey || !serviceRoleKey.trim() ||
          !configuredBucketName || !configuredBucketName.trim()) {
        throw new ScreenshotConfigurationError(
          "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET must be configured for screenshot uploads.",
          "SUPABASE_CONFIGURATION_MISSING"
        );
      }
      if (url.trim() !== url || serviceRoleKey.trim() !== serviceRoleKey ||
          configuredBucketName.trim() !== configuredBucketName ||
          !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(configuredBucketName)) {
        throw new ScreenshotConfigurationError(
          "Supabase screenshot configuration is invalid.",
          "SUPABASE_CONFIGURATION_INVALID"
        );
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        throw new ScreenshotConfigurationError("SUPABASE_URL is invalid.", "SUPABASE_URL_INVALID");
      }
      const isLocalUrl = ["localhost", "127.0.0.1", "::1"].includes(parsedUrl.hostname);
      if (!["https:", "http:"].includes(parsedUrl.protocol) ||
          (parsedUrl.protocol !== "https:" && !isLocalUrl) ||
          (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "") ||
          parsedUrl.search || parsedUrl.hash || parsedUrl.username || parsedUrl.password) {
        throw new ScreenshotConfigurationError("SUPABASE_URL is invalid.", "SUPABASE_URL_INVALID");
      }

      cachedSupabaseClient = supabaseClientFactory(url, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          detectSessionInUrl: false,
          persistSession: false
        }
      });
    }

    if (!cachedSupabaseBucket) {
      const configuredBucketName = environment.SUPABASE_STORAGE_BUCKET;
      if (!configuredBucketName || !configuredBucketName.trim()) {
        throw new ScreenshotConfigurationError(
          "SUPABASE_STORAGE_BUCKET must be configured for screenshot storage.",
          "SUPABASE_CONFIGURATION_MISSING"
        );
      }
      cachedSupabaseBucket = cachedSupabaseClient.storage.from(configuredBucketName);
    }
    return cachedSupabaseBucket;
  }

  async function assertSupabaseBucketIsPrivate() {
    const configuredBucketName = environment.SUPABASE_STORAGE_BUCKET;
    try {
      getSupabaseBucket();
      const { data, error } = await cachedSupabaseClient.storage
        .getBucket(configuredBucketName);
      if (error || !data || data.public !== false) {
        throw new ScreenshotConfigurationError(
          "The Supabase screenshot bucket must exist and be private.",
          data && data.public === true
            ? "SUPABASE_BUCKET_NOT_PRIVATE"
            : "SUPABASE_BUCKET_VERIFICATION_FAILED"
        );
      }
    } catch (error) {
      if (error instanceof ScreenshotConfigurationError) throw error;
      throw new ScreenshotConfigurationError(
        "Unable to verify that the Supabase screenshot bucket is private.",
        "SUPABASE_BUCKET_VERIFICATION_FAILED"
      );
    }
  }

  function getFirebaseBucket() {
    if (!storage || !bucketName) {
      throw new ScreenshotConfigurationError(
        "Firebase Storage is not configured for legacy screenshot retrieval."
      );
    }
    return storage.bucket(bucketName);
  }

  async function getLegacyScreenshot(objectPath) {
    const providers = legacyMode === "local"
      ? [readLocalScreenshot, readFirebaseScreenshot]
      : [readFirebaseScreenshot, readLocalScreenshot];
    let providerError = null;
    let providerMissing = false;

    for (const readFromProvider of providers) {
      try {
        return await readFromProvider(objectPath);
      } catch (error) {
        if (error instanceof ScreenshotNotFoundError) {
          providerMissing = true;
        } else if (!providerError) {
          providerError = error;
        }
      }
    }

    if (providerError) throw providerError;
    if (providerMissing) throw new ScreenshotNotFoundError();
    throw new ScreenshotNotFoundError();
  }

  async function readFirebaseScreenshot(objectPath) {
    try {
      const [buffer] = await getFirebaseBucket().file(objectPath).download();
      return buffer;
    } catch (error) {
      if (isNotFound(error)) throw new ScreenshotNotFoundError();
      throw error;
    }
  }

  async function readLocalScreenshot(objectPath) {
    for (const destination of getLocalCandidates(objectPath)) {
      try {
        return await fs.readFile(destination);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new ScreenshotNotFoundError();
  }

  function getLocalCandidates(objectPath) {
    const configuredDirectory = environment.MANUAL_PAYMENT_UPLOAD_DIR || "private-uploads";
    const roots = [
      path.resolve(path.join(__dirname, "..", "manual-registration"), configuredDirectory),
      path.resolve(path.join(__dirname, ".."), configuredDirectory)
    ];
    const uniqueRoots = [...new Set(roots)];

    return uniqueRoots.map((root) => {
      const destination = path.resolve(root, ...objectPath.split("/"));
      const relativePath = path.relative(root, destination);
      if (relativePath === ".." ||
          relativePath.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relativePath)) {
        throw new InvalidScreenshotPathError();
      }
      return destination;
    });
  }

  return {
    saveScreenshot,
    getScreenshot,
    deleteScreenshot
  };
}

function parseScreenshotPath(storedPath) {
  if (typeof storedPath !== "string" ||
      storedPath.includes("\\") ||
      storedPath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new InvalidScreenshotPathError();
  }

  if (storedPath.startsWith(SUPABASE_PREFIX)) {
  const relativeObjectPath = storedPath.slice(SUPABASE_PREFIX.length);
  if (!SCREENSHOT_PATH_PATTERN.test(relativeObjectPath)) {
      throw new InvalidScreenshotPathError();
    }
  return { provider: "supabase", objectPath: storedPath };
  }

  if (!SCREENSHOT_PATH_PATTERN.test(storedPath)) {
    throw new InvalidScreenshotPathError();
  }
  return { provider: "legacy", objectPath: storedPath };
}

function createStorageOperationError(error, operation) {
  if (isNotFound(error)) return new ScreenshotNotFoundError();
  const wrapped = new Error(`Screenshot ${operation} failed.`);
  wrapped.name = "ScreenshotStorageError";
  wrapped.code = safeErrorCode(error);
  wrapped.cause = error;
  return wrapped;
}

function isNotFound(error) {
  const code = error && String(error.code || "").toLowerCase();
  const status = Number(error && (error.statusCode || error.status));
  return code === "enoent" ||
    code === "storage/object-not-found" ||
    code === "not_found" ||
    status === 404;
}

function safeErrorName(error) {
  return error && typeof error.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
}

function safeErrorCode(error) {
  const code = error && error.code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)
    ? code
    : null;
}

module.exports = {
  createStorageAdapter,
  InvalidScreenshotPathError,
  ScreenshotConfigurationError,
  ScreenshotNotFoundError,
  parseScreenshotPath
};
