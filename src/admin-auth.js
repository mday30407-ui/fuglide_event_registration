const crypto = require("node:crypto");
const express = require("express");
const { REGISTRATION_FEE } = require("./registration-validation");

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
  return process.env.ADMIN_SESSION_SECRET || process.env.SESSION_SECRET || "admin-dashboard-development-secret";
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
    const configured = isAdminConfigured();
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
  const tokenFromHeader = request.get("X-CSRF-Token") || request.get("x-csrf-token");
  const tokenFromCookie = readCookie(request, CSRF_COOKIE_NAME);

  if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
    return next();
  }

  if (tokenFromHeader && tokenFromCookie && safeEqual(tokenFromHeader, tokenFromCookie)) {
    return next();
  }

  const origin = request.get("Origin");
  const host = request.get("Host");
  if (origin && host && origin.replace(/^https?:\/\//i, "") === host) {
    return next();
  }

  if (!tokenFromHeader && !tokenFromCookie) {
    return next();
  }

  return response.status(403).json({ error: "Invalid CSRF token." });
}

function isAdminConfigured() {
  return Boolean(getAdminEmail() && (getAdminPasswordHash() || getAdminPassword()));
}

function createAdminAuth(options = {}) {
  const email = normalizeEmail(options.adminEmail || getAdminEmail());
  const passwordHash = options.adminPasswordHash || getAdminPasswordHash();
  const password = options.adminPassword || getAdminPassword();
  const sessionSecret = options.sessionSecret || getAdminSessionSecret();
  const databaseResolver = typeof options.database === "function"
    ? options.database
    : () => options.database || null;

  const requireAdminAuth = createRequireAuth(true, sessionSecret);
  const requireAdminRole = createRequireAuth(false, sessionSecret);
  const router = express.Router();

  router.use((request, response, next) => {
    if (request.path.startsWith("/api/")) {
      return applyCsrfProtection(request, response, next);
    }
    return next();
  });

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

  router.post("/api/login", (request, response) => {
    if (!isAdminConfigured()) {
      return response.status(503).json({ error: "Admin access is not configured." });
    }

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

  router.post("/api/logout", requireAdminAuth, (request, response) => {
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
        "paymentStatus",
        "razorpayOrderId",
        "razorpayPaymentId",
        "registrationDate",
        "paidAt"
      ];
      const csv = [headers.join(",")].concat(rows.map((row) => headers.map((key) => {
        const value = row[key] === undefined || row[key] === null ? "" : row[key];
        const text = typeof value === "string" ? value.replace(/"/g, '""') : String(value);
        return `"${text}"`;
      }).join(","))).join("\n");
      response.header("Content-Type", "text/csv; charset=utf-8");
      response.header("Content-Disposition", "attachment; filename=registrations.csv");
      return response.send(csv);
    } catch (error) {
      return response.status(503).json({ error: "Unable to export registrations." });
    }
  });

  return {
    router,
    requireAdminAuth,
    requireAdminRole,
    isConfigured: isAdminConfigured,
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
  getAdminSessionSecret
};
