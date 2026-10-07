const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { UPLOAD_DIR, PUBLIC_UPLOAD_PATH } = require("./config/uploads");
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

// 1. Middleware that runs on every request
app.use(requestLogger);
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// 2. Uploaded images. "nosniff" stops browsers guessing a file is something
//    other than the image type we stored.
app.use(
  PUBLIC_UPLOAD_PATH,
  express.static(UPLOAD_DIR, {
    index: false,
    setHeaders: (res) => res.set("X-Content-Type-Options", "nosniff"),
  }),
);

// 3. Routes
app.use("/", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/crumbs", crumbRoutes);
app.use("/api/collections", collectionRoutes);
app.use("/api/widgets", widgetRoutes);
app.use("/api/links", linkRoutes);
app.use("/api/friends", friendRoutes);
app.use("/api/users", userRoutes);

// 4. Order matters: unmatched URLs -> 404, then errors from anywhere above.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
