const LIVE_DB_NAME = "crumbs";
const SANDBOX_DB_NAME = "crumbs_dev";

function getDatabaseName(uri) {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]*\/([^/?]+)(?:\?|$)/);
  return match ? match[1] : "";
}

function assertSafeDatabase(uri) {
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Check your .env file.");
  }

  const isProduction = process.env.NODE_ENV === "production";
  const dbName = getDatabaseName(uri);

  if (!dbName) {
    throw new Error(
      "Could not read a database name from MONGODB_URI. " +
        "Expected mongodb:// or mongodb+srv:// with a database in the path, " +
        'for example ".../crumbs_dev?ssl=true".',
    );
  }

  if (isProduction && dbName !== LIVE_DB_NAME) {
    throw new Error(
      `Refusing to start: NODE_ENV=production but MONGODB_URI points at "${dbName}". ` +
        `Production must use the "${LIVE_DB_NAME}" database.`,
    );
  }

  if (!isProduction && dbName === LIVE_DB_NAME) {
    throw new Error(
      `Refusing to run: MONGODB_URI points at the live "${LIVE_DB_NAME}" database. ` +
        `Development must use "${SANDBOX_DB_NAME}". Change the database name in your .env file.`,
    );
  }

  return dbName;
}

module.exports = {
  LIVE_DB_NAME,
  SANDBOX_DB_NAME,
  getDatabaseName,
  assertSafeDatabase,
};
