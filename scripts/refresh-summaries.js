// Recomputes the card summary and searchable text of EVERY collection in the sandbox
// database. Run it after an update that changes what is stored in them (for
// example, when dates became searchable by month name):
//
//   npm run refresh
//
// Like the seed script, it refuses to touch anything but the sandbox database.

const mongoose = require("mongoose");

process.loadEnvFile();

const { SANDBOX_DB_NAME, getDatabaseName } = require("../config/database");
const Collection = require("../models/Collection");
const { refreshCollectionSummary } = require("../services/collectionSummary");

const dbName = getDatabaseName(process.env.MONGODB_URI ?? "");
if (dbName !== SANDBOX_DB_NAME) {
  console.error(`Refusing to run: MONGODB_URI points at "${dbName}", not "${SANDBOX_DB_NAME}".`);
  process.exit(1);
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const ids = await Collection.find().select("_id").lean();
  for (const { _id } of ids) await refreshCollectionSummary(_id);
  console.log(`Refreshed ${ids.length} collection(s) in ${dbName}.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Refresh failed: ", err.message);
  process.exit(1);
});
