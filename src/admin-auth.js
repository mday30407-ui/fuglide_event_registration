const crypto = require("node:crypto");
const express = require("express");
const { REGISTRATION_FEE } = require("./registration-validation");
const {
  InvalidScreenshotPathError,
  ScreenshotNotFoundError
} = require("./manual-storage");

const AUTH_COOKIE_NAME = "admin_session";
const CSRF_COOKIE_NAME = "admin_csrf";
const SESSION_TTL_MS = Number(process.env.ADMIN_SESSION_TTL_MS || 1000 * 60 * 60 * 8);

function parseCookies(cookieHeader = "") {
  return cookieHeader.split(";").reduce((cookies, chunk) => {
    const trimmed = chunk.trim();
    if (!trimmed) return cookies;
    const separator = trimmed.indexOf("=");
    const name = separator === -1 ? trimmed : trimmed.slice(0, separator);
    const value = separator === -1 ? "" : trimmed.slice(separator + 1);
    cookies[name] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function safeEqual(left, right) {
  try {
    return crypto.timingSafeEqual(
      Buffer.from(left || ""),
      Buffer.from(right || "")
    );
  } catch {
    return false;
  }
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signTokenPayload(payload, secret) {
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyTokenPayload(token, secret) {
  if (typeof token !== "string" || !token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return null;
  }
  const expected = signTokenPayload(payload, secret);
  const actual = `${encoded}.${signature}`;
  if (!safeEqual(actual, expected)) return null;
  if (!payload || typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return null;
  }
  return payload;
}

function createRandomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function setCookie(response, name, value, config = {}) {
  const options = [
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor((config.maxAge || 0) / 1000))}`
  ];
  if (config.path) options.push(`Path=${config.path}`);
  if (config.secure) options.push("Secure");
  response.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; ${options.join("; ")}`);
}

function clearCookie(response, name, path = "/") {
  response.clearCookie(name, { httpOnly: true, sameSite: "Lax", secure: isSecureCookie(), path });
}

function isSecureCookie() {
  return Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
}

function readCookie(request, name) {
  const cookies = parseCookies(request.headers.cookie || "");
  return cookies[name] || null;
}

function createSessionPayload(email) {
  return {
    sub: email,
    role: "admin",
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    jti: createRandomToken()
  };
}

function getClientIp(request) {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return request.ip || "unknown";
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function getAdminEmail() {
  const value = process.env.ADMIN_EMAIL || "";
  return normalizeEmail(value);
}

function getAdminPasswordHash() {
  return process.env.ADMIN_PASSWORD_HASH || "";
}

function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || "";
}

function getAdminSessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || "";
}

function getRateLimitBucket(email, ip) {
  return `${normalizeEmail(email)}:${ip}`;
}

function readAttemptState(bucket) {
  const state = globalThis.__adminLoginAttempts || new Map();
  if (!globalThis.__adminLoginAttempts) globalThis.__adminLoginAttempts = state;
  return state.get(bucket) || { count: 0, lockUntil: 0 };
}

function writeAttemptState(bucket, state) {
  const store = globalThis.__adminLoginAttempts || new Map();
  store.set(bucket, state);
  globalThis.__adminLoginAttempts = store;
}

function isHashAllowed(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function verifyScryptHash(password, hash) {
  const match = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$(.+)\$(.+)$/.exec(hash);
  if (!match) return false;
  const [, n, r, p, salt, expectedHex] = match;
  const derived = crypto.scryptSync(password, salt, 32, {
    N: Number(n),
    r: Number(r),
    p: Number(p)
  });
  return safeEqual(derived.toString("hex"), expectedHex);
}

function verifyPassword(password, configuredHash) {
  if (typeof password !== "string") return false;
  const adminPassword = getAdminPassword();
  if (adminPassword && password === adminPassword && !configuredHash) {
    return true;
  }
  if (adminPassword && password === adminPassword) {
    return true;
  }
  if (!configuredHash && !adminPassword) {
    return false;
  }
  if (configuredHash) {
    const trimmedHash = configuredHash.trim();
    if (trimmedHash === password) return true;
    if (trimmedHash.startsWith("scrypt$") || trimmedHash.startsWith("Scrypt$")) {
      return verifyScryptHash(password, trimmedHash);
    }
    try {
      const bcrypt = require("bcryptjs");
      if (trimmedHash.startsWith("$2a$") || trimmedHash.startsWith("$2b$") || trimmedHash.startsWith("$2y$")) {
        return bcrypt.compareSync(password, trimmedHash);
      }
    } catch {
      // bcrypt not installed; fall through to direct comparison.
    }
    return crypto.createHash("sha256").update(password).digest("hex") === trimmedHash;
  }
  return false;
}

function createRequireAuth(checkRole = true, secret = getAdminSessionSecret()) {
  return function requireAdminAuth(request, response, next) {
    const configured = isAdminConfigured(secret);
    if (!configured) {
      if (request.accepts("html")) {
        return response.status(503).send("Admin access is not configured yet.");
      }
      return response.status(503).json({ error: "Admin access is not configured." });
    }

    const token = readCookie(request, AUTH_COOKIE_NAME);
    if (!token) {
      if (request.accepts("html")) {
        return response.redirect("/admin/login");
      }
      return response.status(401).json({ error: "Unauthorized." });
    }

    const session = verifyTokenPayload(token, secret);
    if (!session) {
      clearCookie(response, AUTH_COOKIE_NAME, "/");
      clearCookie(response, CSRF_COOKIE_NAME, "/");
      if (request.accepts("html")) {
        return response.redirect("/admin/login");
      }
      return response.status(401).json({ error: "Unauthorized." });
    }

    if (checkRole && session.role !== "admin") {
      return response.status(403).json({ error: "Forbidden." });
    }

    request.admin = session;
    return next();
  };
}
function applyCsrfProtection(request, response, next) {
  const tokenFromHeader = request.get("X-CSRF-Token");
  const tokenFromCookie = readCookie(request, CSRF_COOKIE_NAME);

  // Allow safe HTTP methods
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return next();
  }

  // Require both tokens and verify that they match
  if (
    tokenFromHeader &&
    tokenFromCookie &&
    safeEqual(tokenFromHeader, tokenFromCookie)
  ) {
    return next();
  }

  // Reject all other state-changing requests
  return response.status(403).json({ error: "Invalid CSRF token." });
}

function isAdminConfigured(sessionSecret = getAdminSessionSecret()) {
  return Boolean(
    getAdminEmail() &&
    (getAdminPasswordHash() || getAdminPassword()) &&
    typeof sessionSecret === "string" &&
    sessionSecret.length >= 32 &&
    sessionSecret.trim() === sessionSecret
  );
}

function safeStorageErrorName(error) {
  return error && typeof error.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
}

function safeStorageErrorCode(error) {
  const code = error && error.code;
  const normalized = typeof code === "string" || typeof code === "number"
    ? String(code)
    : "";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(normalized) ? normalized : null;
}

function escapeCsvField(value) {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f\u007f-\u009f]*[=+\-@]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function createAdminAuth(options = {}) {
  const email = normalizeEmail(options.adminEmail || getAdminEmail());
  const passwordHash = options.adminPasswordHash || getAdminPasswordHash();
  const password = options.adminPassword || getAdminPassword();
  const sessionSecret = options.sessionSecret || getAdminSessionSecret();
  const databaseResolver = typeof options.database === "function"
    ? options.database
    : () => options.database || null;
  const screenshotStorageResolver = typeof options.screenshotStorage === "function"
    ? options.screenshotStorage
    : () => options.screenshotStorage || null;

  const requireAdminAuth = createRequireAuth(true, sessionSecret);
  const requireAdminRole = createRequireAuth(false, sessionSecret);
  const router = express.Router();

  function requireAdminConfiguration(_request, response, next) {
    if (!isAdminConfigured(sessionSecret)) {
      return response.status(503).json({ error: "Admin access is not configured." });
    }
    return next();
  }

  router.get("/api/session", (request, response) => {
    const csrfToken = readCookie(request, CSRF_COOKIE_NAME) || createRandomToken();
    const session = verifyTokenPayload(readCookie(request, AUTH_COOKIE_NAME), sessionSecret);
    if (!session) {
      setCookie(response, CSRF_COOKIE_NAME, csrfToken, {
        path: "/",
        maxAge: SESSION_TTL_MS,
        secure: isSecureCookie()
      });
      return response.json({ authenticated: false, csrfToken });
    }

    setCookie(response, CSRF_COOKIE_NAME, csrfToken, {
      path: "/",
      maxAge: SESSION_TTL_MS,
      secure: isSecureCookie()
    });
    return response.json({
      authenticated: true,
      csrfToken,
      user: { email: session.sub, role: session.role },
      expiresAt: session.exp
    });
  });

  router.post("/api/login", requireAdminConfiguration, applyCsrfProtection, (request, response) => {
    const suppliedEmail = normalizeEmail(request.body && request.body.email);
    const suppliedPassword = typeof request.body && typeof request.body.password === "string"
      ? request.body.password
      : "";
    const bucket = getRateLimitBucket(suppliedEmail || email, getClientIp(request));
    const attemptState = readAttemptState(bucket);
    const now = Date.now();

    if (attemptState.lockUntil && attemptState.lockUntil > now) {
      return response.status(429).json({ error: "Too many failed login attempts. Please try again later." });
    }

    if (suppliedEmail !== email || !verifyPassword(suppliedPassword, passwordHash)) {
      const nextState = {
        count: (attemptState.count || 0) + 1,
        lockUntil: 0
      };
      if (nextState.count >= 5) {
        nextState.lockUntil = now + 1000 * 60 * 15;
      }
      writeAttemptState(bucket, nextState);
      return response.status(401).json({ error: "Invalid email or password." });
    }

    writeAttemptState(bucket, { count: 0, lockUntil: 0 });
    const session = createSessionPayload(email);
    const token = signTokenPayload(session, sessionSecret);
    const csrfToken = createRandomToken();

    setCookie(response, AUTH_COOKIE_NAME, token, {
      path: "/",
      maxAge: SESSION_TTL_MS,
      secure: isSecureCookie()
    });
    setCookie(response, CSRF_COOKIE_NAME, csrfToken, {
      path: "/",
      maxAge: SESSION_TTL_MS,
      secure: isSecureCookie()
    });

    return response.json({
      authenticated: true,
      user: { email, role: "admin" },
      csrfToken
    });
  });

  router.post("/api/logout", requireAdminAuth, applyCsrfProtection, (request, response) => {
    clearCookie(response, AUTH_COOKIE_NAME, "/");
    clearCookie(response, CSRF_COOKIE_NAME, "/");
    response.json({ success: true });
  });

  router.get("/api/stats", requireAdminAuth, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }

    try {
      const snapshot = await database.collection("event_registrations").get();
      const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const paidCount = rows.filter((row) => row.paymentStatus === "PAID").length;
      const totalRevenue = rows.reduce((sum, row) => sum + Number(row.amountPaid || REGISTRATION_FEE || 0), 0);
      return response.json({
        totalRegistrations: rows.length,
        paidRegistrations: paidCount,
        pendingRegistrations: rows.length - paidCount,
        totalRevenue
      });
    } catch (error) {
      return response.status(503).json({ error: "Unable to load dashboard statistics." });
    }
  });

  router.get("/api/registrations", requireAdminAuth, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }

    try {
      const snapshot = await database.collection("event_registrations")
        .orderBy("registrationDate", "desc")
        .limit(250)
        .get();
      const registrations = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data()
      }));
      return response.json({ registrations });
    } catch (error) {
      return response.status(503).json({ error: "Unable to load registrations." });
    }
  });

  router.delete("/api/registrations/:id", requireAdminAuth, applyCsrfProtection, async (request, response) => {
    const registrationId = request.params.id;
    if (!/^FD26-[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i.test(registrationId)) {
      return response.status(400).json({ error: "Registration ID is invalid." });
    }

    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }

    try {
      const registrationRef = database.collection("event_registrations").doc(registrationId);
      const auditRef = database.collection("admin_audit_logs").doc();
      await database.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(registrationRef);
        if (!snapshot.exists) {
          const error = new Error("Registration not found.");
          error.statusCode = 404;
          throw error;
        }

        const registration = snapshot.data();
        transaction.delete(registrationRef);
        transaction.create(auditRef, {
          action: "REGISTRATION_DELETED",
          registrationType: "razorpay",
          registrationId,
          paymentStatus: registration.paymentStatus || null,
          adminEmail: request.admin.sub,
          deletedAt: new Date()
        });
      });
      return response.json({ success: true, registrationId });
    } catch (error) {
      if (error.statusCode === 404) {
        return response.status(404).json({ error: "Registration not found." });
      }
      return response.status(503).json({ error: "Unable to delete registration." });
    }
  });

  router.get("/api/export/csv", requireAdminAuth, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    try {
      const snapshot = await database.collection("event_registrations").get();
      const rows = snapshot.docs.map((doc) => doc.data());
      const headers = [
        "registrationId",
        "fullName",
        "email",
        "mobile",
        "gender",
        "city",
        "participantCategory",
        "participationType",
        "paymentStatus",
        "razorpayOrderId",
        "razorpayPaymentId",
        "registrationDate",
        "paidAt"
      ];
      const csv = [headers.map(escapeCsvField).join(",")]
        .concat(rows.map((row) => headers.map((key) => escapeCsvField(row[key])).join(",")))
        .join("\n");
      response.header("Content-Type", "text/csv; charset=utf-8");
      response.header("Content-Disposition", "attachment; filename=registrations.csv");
      return response.send(csv);
    } catch (error) {
      return response.status(503).json({ error: "Unable to export registrations." });
    }
  });

  router.get("/api/manual/stats", requireAdminAuth, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    try {
      const snapshot = await database.collection("manual_payment_registrations").get();
      const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      return response.json({
        totalRegistrations: rows.length,
        pendingRegistrations: rows.filter((row) => row.paymentStatus === "PENDING_VERIFICATION").length,
        verifiedRegistrations: rows.filter((row) => row.paymentStatus === "VERIFIED").length,
        rejectedRegistrations: rows.filter((row) => row.paymentStatus === "REJECTED").length,
        verifiedRevenue: rows
          .filter((row) => row.paymentStatus === "VERIFIED")
          .reduce((sum, row) => sum + Number(row.amount || 0), 0)
      });
    } catch {
      return response.status(503).json({ error: "Unable to load manual payment statistics." });
    }
  });

  router.get("/api/manual/registrations", requireAdminAuth, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    try {
      const snapshot = await database.collection("manual_payment_registrations").get();
      let rows = snapshot.docs.map((doc) => {
        const row = { id: doc.id, ...doc.data() };
        delete row.statusAccessTokenHash;
        return row;
      });
      const search = typeof request.query.search === "string"
        ? request.query.search.trim().toLowerCase()
        : "";
      const status = typeof request.query.status === "string"
        ? request.query.status.trim()
        : "";
      if (search) {
        rows = rows.filter((row) => ["fullName", "email", "mobile", "utrNumber"]
          .some((key) => String(row[key] || "").toLowerCase().includes(search)));
      }
      if (status) {
        rows = rows.filter((row) => row.paymentStatus === status);
      }
      rows.sort((left, right) => {
        const leftValue = left.submittedAt && typeof left.submittedAt.toMillis === "function"
          ? left.submittedAt.toMillis()
          : 0;
        const rightValue = right.submittedAt && typeof right.submittedAt.toMillis === "function"
          ? right.submittedAt.toMillis()
          : 0;
        return rightValue - leftValue;
      });
      return response.json({ registrations: rows });
    } catch {
      return response.status(503).json({ error: "Unable to load manual registrations." });
    }
  });

  router.delete("/api/manual/registrations/:id", requireAdminAuth, applyCsrfProtection, async (request, response) => {
    const registrationId = request.params.id;
    if (!/^FD26-M-[A-F0-9]{12}$/.test(registrationId)) {
      return response.status(400).json({ error: "Registration ID is invalid." });
    }

    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }

    try {
      const registrationRef = database.collection("manual_payment_registrations").doc(registrationId);
      const duplicateLocks = database.collection("manual_payment_duplicate_locks");
      const duplicateQuery = duplicateLocks.where("registrationId", "==", registrationId);
      const auditRef = database.collection("admin_audit_logs").doc();
      await database.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(registrationRef);
        if (!snapshot.exists) {
          const error = new Error("Registration not found.");
          error.statusCode = 404;
          throw error;
        }
        const duplicateSnapshot = await transaction.get(duplicateQuery);
        const registration = snapshot.data();
        transaction.delete(registrationRef);
        for (const duplicate of duplicateSnapshot.docs) {
          if (duplicate.data().registrationId === registrationId) {
            transaction.delete(duplicate.ref);
          }
        }
        transaction.create(auditRef, {
          action: "REGISTRATION_DELETED",
          registrationType: "manual",
          registrationId,
          paymentStatus: registration.paymentStatus || null,
          adminEmail: request.admin.sub,
          deletedAt: new Date()
        });
      });
      return response.json({ success: true, registrationId });
    } catch (error) {
      if (error.statusCode === 404) {
        return response.status(404).json({ error: "Registration not found." });
      }
      return response.status(503).json({ error: "Unable to delete registration." });
    }
  });

  router.get("/api/manual/registrations/:id/screenshot", requireAdminAuth, async (request, response) => {
    const registrationId = request.params.id;
    if (!/^FD26-M-[A-F0-9]{12}$/.test(registrationId)) {
      return response.status(404).json({ error: "Payment screenshot is unavailable." });
    }
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    try {
      const snapshot = await database.collection("manual_payment_registrations")
        .doc(registrationId)
        .get();
      if (!snapshot.exists) {
        return response.status(404).json({ error: "Registration not found." });
      }
      const objectPath = snapshot.data().paymentScreenshotStoragePath;
      if (typeof objectPath !== "string" ||
          !objectPath) {
        return response.status(404).json({ error: "Payment screenshot is unavailable." });
      }
      const screenshotStorage = screenshotStorageResolver();
      if (!screenshotStorage ||
          typeof screenshotStorage.getScreenshot !== "function") {
        return response.status(503).json({ error: "Payment screenshot storage is unavailable." });
      }
      const contentType = objectPath.endsWith(".png") ? "image/png"
        : objectPath.endsWith(".webp") ? "image/webp"
          : "image/jpeg";
      const buffer = await screenshotStorage.getScreenshot(objectPath);
      const extension = contentType === "image/png" ? "png"
        : contentType === "image/webp" ? "webp" : "jpg";
      response.set("Cache-Control", "no-store, private");
      response.set("Pragma", "no-cache");
      response.set("Referrer-Policy", "no-referrer");
      response.set("X-Content-Type-Options", "nosniff");
      response.set("Content-Disposition", `inline; filename="payment-screenshot.${extension}"`);
      response.type(contentType);
      return response.send(buffer);
    } catch (error) {
      if (error instanceof ScreenshotNotFoundError ||
          error instanceof InvalidScreenshotPathError) {
        return response.status(404).json({ error: "Payment screenshot is unavailable." });
      }
      console.error("Admin screenshot retrieval failed:", {
        registrationId,
        name: safeStorageErrorName(error),
        code: safeStorageErrorCode(error)
      });
      return response.status(503).json({ error: "Payment screenshot is temporarily unavailable." });
    }
  });

  router.post("/api/manual/registrations/:id/approve", requireAdminAuth, applyCsrfProtection, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    try {
      const registrationRef = database.collection("manual_payment_registrations")
        .doc(request.params.id);
      await database.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(registrationRef);
        if (!snapshot.exists) {
          const error = new Error("Registration not found.");
          error.statusCode = 404;
          throw error;
        }
        if (snapshot.data().paymentStatus !== "PENDING_VERIFICATION") {
          const error = new Error("Registration is no longer pending verification.");
          error.statusCode = 409;
          throw error;
        }
        transaction.update(registrationRef, {
          paymentStatus: "VERIFIED",
          invitationStatus: "READY_TO_SEND",
          rejectionReason: null,
          verifiedAt: new Date(),
          verifiedBy: request.admin.sub
        });
      });
      return response.json({ success: true, paymentStatus: "VERIFIED" });
    } catch (error) {
      if (error.statusCode === 404) {
        return response.status(404).json({ error: "Registration not found." });
      }
      if (error.statusCode === 409) {
        return response.status(409).json({ error: "Registration is no longer pending verification." });
      }
      return response.status(500).json({ error: "The payment could not be approved." });
    }
  });

  router.post("/api/manual/registrations/:id/reject", requireAdminAuth, applyCsrfProtection, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    const reason = typeof request.body?.rejectionReason === "string"
      ? request.body.rejectionReason.trim()
      : "";
    if (!reason || reason.length > 500) {
      return response.status(400).json({ error: "A rejection reason is required." });
    }
    try {
      const registrationRef = database.collection("manual_payment_registrations")
        .doc(request.params.id);
      await database.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(registrationRef);
        if (!snapshot.exists) {
          const error = new Error("Registration not found.");
          error.statusCode = 404;
          throw error;
        }
        if (snapshot.data().paymentStatus !== "PENDING_VERIFICATION") {
          const error = new Error("Registration is no longer pending verification.");
          error.statusCode = 409;
          throw error;
        }
        transaction.update(registrationRef, {
          paymentStatus: "REJECTED",
          invitationStatus: "NOT_READY",
          rejectionReason: reason,
          verifiedAt: new Date(),
          verifiedBy: request.admin.sub
        });
      });
      return response.json({ success: true, paymentStatus: "REJECTED" });
    } catch (error) {
      if (error.statusCode === 404) {
        return response.status(404).json({ error: "Registration not found." });
      }
      if (error.statusCode === 409) {
        return response.status(409).json({ error: "Registration is no longer pending verification." });
      }
      return response.status(500).json({ error: "The payment could not be rejected." });
    }
  });

  router.get("/api/manual/export/csv", requireAdminAuth, async (request, response) => {
    const database = databaseResolver();
    if (!database) {
      return response.status(503).json({ error: "Admin data source is not available." });
    }
    try {
      const snapshot = await database.collection("manual_payment_registrations").get();
      const headers = [
        "registrationId", "fullName", "email", "mobile", "city", "college",
        "participantCategory", "participationType", "utrNumber", "amount",
        "paymentStatus", "invitationStatus", "submittedAt", "verifiedAt",
        "verifiedBy", "rejectionReason"
      ];
      const rows = snapshot.docs.map((doc) => {
        const row = doc.data();
        return headers.map((key) => escapeCsvField(row[key])).join(",");
      });
      response.header("Content-Type", "text/csv; charset=utf-8");
      response.header("Content-Disposition", "attachment; filename=manual-payment-registrations.csv");
      return response.send([headers.map(escapeCsvField).join(","), ...rows].join("\n"));
    } catch {
      return response.status(503).json({ error: "Unable to export manual registrations." });
    }
  });

  return {
    router,
    requireAdminAuth,
    requireAdminRole,
    isConfigured: () => isAdminConfigured(sessionSecret),
    createSession: createSessionPayload,
    verifySession: (token) => verifyTokenPayload(token, sessionSecret),
    verifyPassword: (password, hash) => verifyPassword(password, hash || passwordHash)
  };
}

module.exports = {
  AUTH_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  createAdminAuth,
  createRequireAuth,
  verifyPassword,
  parseCookies,
  getAdminSessionSecret,
  escapeCsvField
};
