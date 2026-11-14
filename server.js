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

try {
  require("dotenv").config();
  express = require("express");
  helmet = require("helmet");
  path = require("node:path");
  ({ createRegistrationRouter } = require("./src/registration-routes"));
  ({ createDatabase } = require("./src/db"));
  ({ createRegistrationStore } = require("./src/registration-store"));
} catch (error) {
  logStartupFailure("module-import", error);
  throw error;
}

function createApp(options = {}) {
  const app = express();
  let registrationStore = options.store || null;

  function getRegistrationStore() {
    if (registrationStore) return registrationStore;

    try {
      const database = options.database || createDatabase();
      registrationStore = createRegistrationStore(database);
      return registrationStore;
    } catch (error) {
      console.error("Unable to initialize database-backed API:", {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : "Unknown initialization error."
      });
      const unavailableError = new Error("Database-backed API initialization failed.");
      unavailableError.statusCode = 503;
      throw unavailableError;
    }
  }

  const lazyStore = new Proxy({}, {
    get(_target, property) {
      const store = getRegistrationStore();
      const value = store[property];
      return typeof value === "function" ? value.bind(store) : value;
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
        imgSrc: ["'self'", "data:", "https:"],
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
  const staticOptions = {
    etag: true,
    maxAge: 0,
    index: false
  };
  app.use(express.static(publicDirectory, staticOptions));
  app.use("/public", express.static(publicDirectory, staticOptions));
  app.use("/api", registrationRouter);
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