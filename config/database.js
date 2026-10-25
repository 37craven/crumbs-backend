const LIVE_DB_NAME = "crumbs";
const SANDBOX_DB_NAME = "crumbs_dev";
const PREVIEW_DB_NAME = "crumbs_preview";

function getDatabaseName(uri) {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]*\/([^/?]+)(?:\?|$)/);
  return match ? match[1] : "";
}

function assertSafeDatabase(uri) {
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Check your .env file.");
  }

  const isProduction = process.env.NODE_ENV === "production";
  const isVercelPreview = process.env.VERCEL_ENV === "preview";
  const dbName = getDatabaseName(uri);

  if (!dbName) {
    throw new Error(
      "Could not read a database name from MONGODB_URI. " +
        "Expected mongodb:// or mongodb+srv:// with a database in the path, " +
        'for example ".../crumbs_dev?ssl=true".',
    );
  }

  if (isVercelPreview && dbName !== PREVIEW_DB_NAME) {
    throw new Error(
      `Refusing to start: this is a Vercel preview but MONGODB_URI points at "${dbName}". ` +
        `Previews must use the "${PREVIEW_DB_NAME}" database.`,
    );
  }

  if (!isVercelPreview && isProduction && dbName !== LIVE_DB_NAME) {
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
  PREVIEW_DB_NAME,
  getDatabaseName,
  assertSafeDatabase,
};
