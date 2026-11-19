const path = require("node:path");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");

function createStorageAdapter({ storage, bucketName, mode = process.env.MANUAL_PAYMENT_STORAGE || "firebase" }) {
  const uploadDirectory = path.resolve(
    path.join(__dirname, ".."),
    process.env.MANUAL_PAYMENT_UPLOAD_DIR || "private-uploads"
  );
  const bucket = mode === "firebase" && bucketName && storage
    ? storage.bucket(bucketName)
    : null;

  if (mode !== "firebase" && mode !== "local") {
    throw new Error("MANUAL_PAYMENT_STORAGE must be firebase or local.");
  }
  if (mode === "firebase" && !bucket) {
    throw new Error("FIREBASE_STORAGE_BUCKET must be configured for Firebase screenshot storage.");
  }

  return {
    async saveScreenshot(registrationId, file) {
      const extension = file.mimetype === "image/png" ? "png" :
        file.mimetype === "image/webp" ? "webp" : "jpg";
      const objectPath = `manual-payment-screenshots/${registrationId}/${crypto.randomUUID()}.${extension}`;
      if (mode === "local") {
        const destination = resolveLocalPath(objectPath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, file.buffer, { flag: "wx", mode: 0o600 });
        return objectPath;
      }
      const object = bucket.file(objectPath);
      await object.save(file.buffer, {
        resumable: false,
        metadata: { contentType: file.mimetype, metadata: { registrationId } }
      });
      return objectPath;
    },

    async getScreenshot(objectPath) {
      if (mode === "local") return fs.readFile(resolveLocalPath(objectPath));
      const [buffer] = await bucket.file(resolveObjectPath(objectPath)).download();
      return buffer;
    },

    async deleteScreenshot(objectPath) {
      if (mode === "local") {
        await fs.unlink(resolveLocalPath(objectPath)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
        return;
      }
      await bucket.file(resolveObjectPath(objectPath)).delete({ ignoreNotFound: true });
    }
  };

  function resolveLocalPath(objectPath) {
    const normalized = resolveObjectPath(objectPath);
    const destination = path.resolve(uploadDirectory, ...normalized.split("/"));
    if (!destination.startsWith(`${uploadDirectory}${path.sep}`)) {
      throw new Error("Invalid screenshot reference.");
    }
    return destination;
  }
}

function resolveObjectPath(objectPath) {
  if (typeof objectPath !== "string" ||
      !objectPath.startsWith("manual-payment-screenshots/") ||
      objectPath.includes("\\") ||
      objectPath.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid screenshot reference.");
  }
  return objectPath;
}

module.exports = { createStorageAdapter };
