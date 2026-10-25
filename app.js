const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const { connectDB } = require("./config/connection");
const requestLogger = require("./middleware/requestLogger");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");
const healthRoutes = require("./routes/health");
const authRoutes = require("./routes/auth");
const crumbRoutes = require("./routes/crumbs");
const collectionRoutes = require("./routes/collections");
const widgetRoutes = require("./routes/widgets");
const linkRoutes = require("./routes/links");
const friendRoutes = require("./routes/friends");
const userRoutes = require("./routes/users");

const app = express();

app.set("trust proxy", 1);

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Check your .env file.");
}

// 1. Middleware that runs on every request
app.use(requestLogger);

// Security headers. The API only answers JSON and image bytes, so its own CSP
// can forbid every subresource (the SPA's CSP is set by the frontend, where the
// HTML actually lives). `cross-origin` is deliberate: the React app runs on a
// different origin in development and loads pictures from here with <img>.
const helmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  frameguard: { action: "deny" },
};
if (process.env.NODE_ENV !== "production") {
  // HSTS on plain-HTTP localhost is pointless, and browsers ignore it there.
  helmetOptions.strictTransportSecurity = false;
}
app.use(helmet(helmetOptions));

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// 2. Routes
app.use("/", healthRoutes);
app.use("/api", healthRoutes);

if (process.env.NODE_ENV !== "test") {
  app.use(async (req, res, next) => {
    try {
      await connectDB();
      next();
    } catch (err) {
      console.error("Database connection failed:", err.message);
      res.status(503).json({ message: "Database unavailable" });
    }
  });
}

app.use("/api/auth", authRoutes);
app.use("/api/crumbs", crumbRoutes);
app.use("/api/collections", collectionRoutes);
app.use("/api/widgets", widgetRoutes);
app.use("/api/links", linkRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/users", userRoutes);

// 3. Order matters: unmatched URLs -> 404, then errors from anywhere above.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
