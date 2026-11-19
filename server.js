function logStartupFailure(stage, error) {
  console.error("Vercel Express startup failed:", {
    stage,
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : "Unknown startup error."
  });
}

let express;
let helmet;
let path;
let createRegistrationRouter;
let createDatabase;
let createRegistrationStore;
let createAdminAuth;
let parseCookies;
let logRequestDiagnostic;
let markDiagnosticLogged;

try {
  require("dotenv").config();
  express = require("express");
  helmet = require("helmet");
  path = require("node:path");
  ({ createRegistrationRouter } = require("./src/registration-routes"));
  ({ createDatabase } = require("./src/db"));
  ({ createRegistrationStore } = require("./src/registration-store"));
  ({ createAdminAuth, parseCookies } = require("./src/admin-auth"));
  ({ logRequestDiagnostic, markDiagnosticLogged } = require("./src/request-diagnostics"));
} catch (error) {
  logStartupFailure("module-import", error);
  throw error;
}

function createApp(options = {}) {
  const app = express();
  let registrationStore = options.store || null;

  function getRegistrationStore(context) {
    const requestId = context && context.requestId;
    if (registrationStore) {
      logStoreReady(context);
      return registrationStore;
    }

    try {
      const database = options.database || createDatabase();
      registrationStore = createRegistrationStore(database);
      logStoreReady(context);
      return registrationStore;
    } catch (error) {
      logRequestDiagnostic(requestId, "firebase_store_initialization", "failed", error);
      const unavailableError = new Error(
        "Database-backed API initialization failed.",
        { cause: error }
      );
      unavailableError.statusCode = 503;
      markDiagnosticLogged(unavailableError);
      throw unavailableError;
    }
  }

  function logStoreReady(context) {
    if (!context || context.firebaseStoreInitializationLogged) return;
    context.firebaseStoreInitializationLogged = true;
    logRequestDiagnostic(
      context.requestId,
      "firebase_store_initialization",
      "completed"
    );
  }

  const lazyStore = new Proxy({}, {
    get(_target, property) {
      return (...args) => {
        const context = args[args.length - 1];
        const requestContext = context && typeof context === "object" &&
          typeof context.requestId === "string"
          ? context
          : null;
        const store = getRegistrationStore(requestContext);
        const value = store[property];
        return typeof value === "function" ? value.apply(store, args) : value;
      };
    }
  });
  const registrationRouter = createRegistrationRouter({
    store: lazyStore,
    paymentsEnabled: options.paymentsEnabled !== false
  });

  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy !== undefined
    ? options.trustProxy
    : Number(process.env.TRUST_PROXY || 0));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'", "https://api.razorpay.com"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'", "https://api.razorpay.com"],
        frameSrc: ["'self'", "https://api.razorpay.com", "https://checkout.razorpay.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "https://checkout.razorpay.com"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    },
    crossOriginEmbedderPolicy: false
  }));
  app.use("/api/webhooks/razorpay", express.raw({
    type: "application/json",
    limit: "16kb"
  }));
  app.use(express.json({ limit: "16kb", strict: true }));
  const publicDirectory = path.join(__dirname, "public");
  const adminDashboardDirectory = path.join(__dirname, "admin-dashboard");
  const staticOptions = {
    etag: true,
    maxAge: 0,
    index: false
  };

  const adminAuth = createAdminAuth({
    database: () => {
      if (options.database) return options.database;
      return createDatabase();
    }
  });

  app.use(express.static(publicDirectory, staticOptions));
  app.use("/public", express.static(publicDirectory, staticOptions));
  app.use("/api", registrationRouter);
  let manualRegistrationRouter = null;
  app.use("/api", (request, response, next) => {
    if (request.path !== "/registrations" && request.path !== "/registration-status") {
      return next();
    }
    try {
      if (!manualRegistrationRouter) {
        const { createRegistrationRouter } = require("./src/manual-registration-routes");
        const { createFirebase } = require("./src/manual-firebase");
        const { createStorageAdapter } = require("./src/manual-storage");
        const firebase = createFirebase();
        const storage = createStorageAdapter({
          storage: firebase.storage,
          bucketName: firebase.bucketName
        });
        manualRegistrationRouter = createRegistrationRouter({
          firestore: firebase.firestore,
          storage
        });
      }
      return manualRegistrationRouter(request, response, next);
    } catch (error) {
      logRequestDiagnostic(
        "manual-registration",
        "manual_registration_initialization",
        "failed",
        error
      );
      return response.status(503).json({
        error: "Manual registration is currently unavailable."
      });
    }
  });

  app.use("/admin", adminAuth.router);

  app.get("/admin/login", (request, response) => {
    const cookies = parseCookies(request.headers.cookie || "");
    if (cookies.admin_session) {
      return response.redirect("/admin");
    }
    return response.sendFile(path.join(adminDashboardDirectory, "login.html"));
  });

  app.get("/admin", adminAuth.requireAdminAuth, (_request, response) => {
    response.sendFile(path.join(adminDashboardDirectory, "index.html"));
  });
  app.use("/admin", express.static(adminDashboardDirectory, staticOptions));
  app.get("/", (_request, response) => response.sendFile(path.join(__dirname, "index.html")));
  app.use((error, _request, response, _next) => {
    if (error.type === "entity.too.large" || error.type === "entity.parse.failed") {
      return response.status(error.type === "entity.too.large" ? 413 : 400)
        .json({ error: "The request could not be processed." });
    }
    console.error("Unhandled request error:", error);
    return response.status(500).json({ error: "Something went wrong. Please try again." });
  });
  return app;
}

let app;
try {
  app = createApp();
} catch (error) {
  logStartupFailure("app-creation", error);
  throw error;
}

app.config = {
  api: {
    bodyParser: false
  }
};

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`FU-GLIDE registration server listening on port ${port}`);
  });
}

module.exports = app;
module.exports.createApp = createApp;