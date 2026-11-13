require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const path = require("node:path");
const { createRegistrationRouter } = require("./src/registration-routes");
const { createDatabase } = require("./src/db");
const { createRegistrationStore } = require("./src/registration-store");

function createApp(options = {}) {
  const database = options.database || (options.store ? null : createDatabase());
  const store = options.store || createRegistrationStore(database);
  const app = express();

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
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use("/public", express.static(path.join(__dirname, "public"), {
    etag: true,
    maxAge: 0,
    index: false
  }));
  app.use("/api", createRegistrationRouter({
    store,
    paymentsEnabled: options.paymentsEnabled !== false
  }));
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

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`FU-GLIDE registration server listening on port ${port}`);
  });
}

module.exports = { createApp };