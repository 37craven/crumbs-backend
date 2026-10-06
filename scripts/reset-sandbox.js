const mongoose = require("mongoose");
const { SANDBOX_DB_NAME, getDatabaseName } = require("../config/database");

process.loadEnvFile();

const dbName = getDatabaseName(process.env.MONGODB_URI ?? "");

if (dbName !== SANDBOX_DB_NAME) {
  console.error(
    `Refusing to reset: MONGODB_URI points at "${dbName}", not the sandbox "${SANDBOX_DB_NAME}".`,
  );
  console.error("This script only ever drops sandbox data.");
  process.exit(1);
}

async function reset() {
  await mongoose.connect(process.env.MONGODB_URI);

  const cursor = await mongoose.connection.db.listCollections();
  const collections = await cursor.toArray();

  for (const { name } of collections) {
    const { deletedCount } = await mongoose.connection.db
      .collection(name)
      .deleteMany({});

    console.log(
      deletedCount > 0
        ? `cleared ${name} (${deletedCount} document${deletedCount === 1 ? "" : "s"})`
        : `${name} already empty`,
    );
  }

  if (collections.length === 0) {
    console.log("sandbox has no collections yet");
  }

  console.log(`\nReset complete: ${dbName} is empty.`);
  await mongoose.disconnect();
}

reset().catch((err) => {
  console.error("Reset failed: ", err.message);
  process.exit(1);
});
