const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const { validateRegistration, validateImage, duplicateKey, ValidationError } = require("./manual-validation");
const { ScreenshotConfigurationError } = require("./manual-storage");
const {
  createStatusAccessToken,
  hashStatusAccessToken,
  matchesStatusAccessToken
} = require("./manual-status-access");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 }
});

function handleScreenshotUpload(request, response, next) {
  upload.single("paymentScreenshot")(request, response, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({ error: error.code === "LIMIT_FILE_SIZE"
          ? "The payment screenshot must be 5 MB or smaller."
          : "The uploaded file could not be processed." });
    }
    return next(error);
  });
}

function createRegistrationRouter({ firestore, storage }) {
  const router = express.Router();

  router.post("/registration-status",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many status checks. Please wait and try again." }
    }),
    async (request, response) => {
      const { registrationId, accessToken } = request.body || {};
      if (typeof registrationId !== "string" ||
          !/^FD26-M-[A-F0-9]{12}$/.test(registrationId) ||
          typeof accessToken !== "string" ||
          !/^[A-Za-z0-9_-]{43}$/.test(accessToken)) {
        return response.status(404).json({ error: "Registration status could not be found." });
      }

      try {
        const snapshot = await firestore.collection("manual_payment_registrations")
          .doc(registrationId)
          .get();
        if (!snapshot.exists ||
            !matchesStatusAccessToken(accessToken, snapshot.data().statusAccessTokenHash)) {
          return response.status(404).json({ error: "Registration status could not be found." });
        }

        const registration = snapshot.data();
        const toIso = (value) => {
          if (!value) return null;
          if (value instanceof Date) return value.toISOString();
          if (typeof value.toDate === "function") return value.toDate().toISOString();
          return null;
        };
        response.set("Cache-Control", "no-store");
        response.set("Referrer-Policy", "no-referrer");
        return response.json({
          registrationId: registration.registrationId,
          fullName: registration.fullName,
          paymentStatus: registration.paymentStatus,
          invitationStatus: registration.invitationStatus,
          submittedAt: toIso(registration.submittedAt),
          verifiedAt: toIso(registration.verifiedAt),
          rejectionReason: registration.paymentStatus === "REJECTED"
            ? registration.rejectionReason
            : null
        });
      } catch {
        return response.status(503).json({ error: "Unable to check registration status right now." });
      }
    }
  );

  router.post("/registrations",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many submissions. Please wait and try again." }
    }),
    handleScreenshotUpload,
    async (request, response) => {
      let storedPath = null;
      let registrationId = null;
      try {
        if (!request.file) throw new ValidationError("Payment screenshot is required.");
        validateImage(request.file.buffer, request.file.mimetype);
        const registration = validateRegistration(request.body);
        const statusAccessToken = createStatusAccessToken();
        const key = duplicateKey(registration.email, registration.utrNumber);
        const duplicateRef = firestore.collection("manual_payment_duplicate_locks").doc(key);

        const submitted = await firestore.runTransaction(async (transaction) => {
          const duplicate = await transaction.get(duplicateRef);
          if (duplicate.exists) {
            const error = new ValidationError("A registration with these details has already been submitted.");
            error.statusCode = 409;
            throw error;
          }
          const registrationId = `FD26-M-${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
          const registrationRef = firestore.collection("manual_payment_registrations").doc(registrationId);
          const submittedAt = new Date();
          transaction.create(registrationRef, {
            registrationId,
            ...registration,
            statusAccessTokenHash: hashStatusAccessToken(statusAccessToken),
            amount: 100,
            utrNumber: registration.utrNumber,
            paymentScreenshotStoragePath: "",
            paymentStatus: "PENDING_VERIFICATION",
            invitationStatus: "NOT_READY",
            submittedAt,
            verifiedAt: null,
            verifiedBy: null,
            rejectionReason: null
          });
          transaction.create(duplicateRef, {
            registrationId,
            email: registration.email,
            utrNumber: registration.utrNumber,
            submittedAt
          });
          return { registrationId, fullName: registration.fullName, submittedAt };
        });

        registrationId = submitted.registrationId;
        const registrationRef = firestore.collection("manual_payment_registrations")
          .doc(submitted.registrationId);
        try {
          storedPath = await storage.saveScreenshot(submitted.registrationId, request.file);
          await registrationRef.update({ paymentScreenshotStoragePath: storedPath });
        } catch (error) {
          const cleanupPath = storedPath ||
            (typeof error.storagePath === "string" ? error.storagePath : null);
          const rolledBack = await rollbackRegistration({
            firestore,
            registrationRef,
            duplicateRef,
            registrationId: submitted.registrationId,
            screenshotPath: cleanupPath
          });
          if (rolledBack && cleanupPath &&
              typeof storage.deleteScreenshot === "function") {
            try {
              await storage.deleteScreenshot(cleanupPath);
            } catch (cleanupError) {
              logRollbackFailure(
                "screenshot_delete",
                cleanupError,
                submitted.registrationId,
                cleanupPath
              );
            }
          }
          throw error;
        }

        response.status(201).json({
          registrationId: submitted.registrationId,
          fullName: submitted.fullName,
          submittedAt: submitted.submittedAt.toISOString(),
          paymentStatus: "PENDING_VERIFICATION",
          statusAccessToken
        });
      } catch (error) {
        if (error instanceof multer.MulterError) {
          return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400)
            .json({ error: error.code === "LIMIT_FILE_SIZE"
              ? "The payment screenshot must be 5 MB or smaller."
              : "The uploaded file could not be processed." });
        }
        if (error instanceof ValidationError || error.statusCode === 409) {
          return response.status(error.statusCode || 400).json({ error: error.message });
        }
        if (error instanceof ScreenshotConfigurationError) {
          console.error("Manual screenshot storage configuration failed:", {
            registrationId,
            name: safeErrorName(error),
            code: safeErrorCode(error),
            message: error.message
          });
          return response.status(503).json({
            error: "Payment screenshot storage is not configured."
          });
        }
        console.error("Manual registration submission failed:", {
          registrationId,
          name: safeErrorName(error),
          code: safeErrorCode(error)
        });
        return response.status(500).json({ error: "Registration could not be submitted. Please try again." });
      }
    }
  );

  return router;
}

async function rollbackRegistration({
  firestore,
  registrationRef,
  duplicateRef,
  registrationId,
  screenshotPath
}) {
  try {
    await firestore.runTransaction(async (transaction) => {
      const registrationSnapshot = await transaction.get(registrationRef);
      const duplicateSnapshot = await transaction.get(duplicateRef);

      if (registrationSnapshot.exists) {
        const registration = registrationSnapshot.data();
        const currentPath = registration.paymentScreenshotStoragePath;
        if (registration.registrationId !== registrationId ||
            (currentPath && currentPath !== screenshotPath)) {
          throw new Error("Registration changed before rollback.");
        }
        transaction.delete(registrationRef);
      }

      if (duplicateSnapshot.exists) {
        if (duplicateSnapshot.data().registrationId !== registrationId) {
          throw new Error("Duplicate lock changed before rollback.");
        }
        transaction.delete(duplicateRef);
      }
    });
    return true;
  } catch (error) {
    logRollbackFailure(
      "firestore_rollback",
      error,
      registrationId,
      screenshotPath
    );
    return false;
  }
}

function logRollbackFailure(operation, error, registrationId, screenshotPath) {
  console.error("Manual registration rollback failed:", {
    operation,
    registrationId,
    screenshotPath,
    name: safeErrorName(error),
    code: safeErrorCode(error)
  });
}

function safeErrorName(error) {
  return error && typeof error.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
}

function safeErrorCode(error) {
  const code = error && error.code;
  const normalized = typeof code === "string" || typeof code === "number"
    ? String(code)
    : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(normalized) ? normalized : null;
}

module.exports = { createRegistrationRouter };
