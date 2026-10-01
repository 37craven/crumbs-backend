const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/auth");
const { assertSafeDatabase } = require("./config/database");

process.loadEnvFile();

const app = express();
const PORT = process.env.PORT ?? 3000;

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Check your .env file.");
}

const dbName = assertSafeDatabase(process.env.MONGODB_URI);

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log(`Connected to MongoDB (${dbName})`))
  .catch((err) => {
    console.error("Connection failed: ", err.message);
    process.exit(1);
  });

app.get("/", (req, res) => res.send("Initial commit!"));

app.get("/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const state = mongoose.connection.readyState;
  res.json({
    status: "ok",
    database: states[state] ?? "unknown",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status ?? 500).json({ message: "Internal server error" });
});

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
