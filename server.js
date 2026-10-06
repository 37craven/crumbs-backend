const mongoose = require("mongoose");

// Load .env BEFORE requiring anything that reads process.env.
process.loadEnvFile();

const { assertSafeDatabase } = require("./config/database");
const Event = require("./models/Event");
const Friendship = require("./models/Friendship");
const { Widget } = require("./models/Widget");
const app = require("./app");

const PORT = process.env.PORT ?? 3000;

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is not set. Check your .env file.");
}

const dbName = assertSafeDatabase(process.env.MONGODB_URI);

mongoose
  .connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log(`Connected to MongoDB (${dbName})`);
    // Makes the database indexes match the schemas, and drops indexes the
    // schemas no longer define. Needed once after the widget rules changed.
    await Promise.all([Event.syncIndexes(), Widget.syncIndexes(), Friendship.syncIndexes()]);
    console.log("Indexes up to date");
  })
  .catch((err) => {
    console.error("Connection failed: ", err.message);
    process.exit(1);
  });

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
