const mongoose = require("mongoose");

process.loadEnvFile();

const { assertSafeDatabase } = require("../config/database");
const Collection = require("../models/Collection");
const Friendship = require("../models/Friendship");
const { Widget } = require("../models/Widget");

async function run() {
  const dbName = assertSafeDatabase(process.env.MONGODB_URI);

  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    Collection.syncIndexes(),
    Widget.syncIndexes(),
    Friendship.syncIndexes(),
  ]);
  console.log(`Indexes up to date (${dbName})`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Could not sync indexes: ", err.message);
  process.exit(1);
});
