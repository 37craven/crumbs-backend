const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

router.get("/", (req, res) => res.send("Crumbs API"));

router.get("/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const state = mongoose.connection.readyState;
  res.json({
    status: "ok",
    database: states[state] ?? "unknown",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
