const path = require("node:path");
const express = require("express");
const mongoose = require("mongoose");
const { connectDB } = require("../config/connection");

const router = express.Router();
const FAVICON_PATH = path.join(__dirname, "..", "public", "favicon.svg");

router.get("/", (req, res) => res.send("Crumbs API"));

router.get(["/favicon.ico", "/favicon.svg"], (req, res) => {
  res.type("image/svg+xml").sendFile(FAVICON_PATH);
});

router.get("/health", async (req, res) => {
  if (process.env.NODE_ENV !== "test" && mongoose.connection.readyState !== 1) {
    try {
      await connectDB();
    } catch {}
  }

  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const state = mongoose.connection.readyState;
  const connected = state === 1;
  res.status(connected ? 200 : 503).json({
    status: connected ? "ok" : "degraded",
    database: states[state] ?? "unknown",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
