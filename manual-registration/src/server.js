require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const path = require("node:path");
const rateLimit = require("express-rate-limit");
const { createFirebase } = require("./firebase");
const { createStorageAdapter } = require("./storage");
const { createRegistrationRouter } = require("./registration-routes");

function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy !== undefined ? options.trustProxy : Number(process.env.TRUST_PROXY || 0));
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginResourcePolicy: { policy: "same-origin" }
  }));
  app.use(express.json({ limit: "16kb", strict: true }));

  const publicDirectory = path.join(__dirname, "..", "public");
  const firebase = options.firebase || createFirebase();
  const storage = options.storage || createStorageAdapter({
    storage: firebase.storage,
    bucketName: firebase.bucketName,
    mode: options.storageMode
  });
  const registrationRouter = createRegistrationRouter({ firestore: firebase.firestore, storage });

  app.use("/api", registrationRouter);
  app.use("/assets", express.static(path.join(publicDirectory, "assets"), { index: false, maxAge: 0 }));
  app.use(express.static(publicDirectory, { index: false, maxAge: 0 }));
  app.get("/", (_request, response) => response.sendFile(path.join(publicDirectory, "index.html")));

  app.use((error, _request, response, _next) => {
    if (error.statusCode === 403) return response.status(403).json({ error: "Invalid CSRF token." });
    if (error.type === "entity.too.large") return response.status(413).json({ error: "The request is too large." });
    console.error("Manual registration server error");
    return response.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3001);
  try {
    const app = createApp();
    app.listen(port, () => console.log(`Manual registration server listening on port ${port}`));
  } catch (error) {
    console.error("Manual registration server could not start.");
    process.exit(1);
  }
}

module.exports = { createApp };
