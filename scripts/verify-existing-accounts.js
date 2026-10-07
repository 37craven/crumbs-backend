// One-off. Marks accounts that existed before email verification as verified.
//
// Verification became mandatory, and every account created before it has an
// address nobody ever wrote to. Locking those out would punish users for our
// change, so this records that they were grandfathered in.
//
// Safe to run twice: accounts already marked verified are left alone.
//
//   npm run verify:existing

const mongoose = require("mongoose");

process.loadEnvFile();

const User = require("../models/User");
const { SANDBOX_DB_NAME, getDatabaseName } = require("../config/database");

const dbName = getDatabaseName(process.env.MONGODB_URI ?? "");

if (dbName !== SANDBOX_DB_NAME) {
  console.error(
    `Refusing to run: MONGODB_URI points at "${dbName}", not the sandbox "${SANDBOX_DB_NAME}".`,
  );
  process.exit(1);
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Only accounts that predate verification: those with no decision recorded.
  const result = await User.updateMany(
    { emailVerified: { $exists: false } },
    {
      $set: { emailVerified: true },
      $setOnInsert: {},
      $currentDate: { emailVerifiedAt: true },
    },
  );

  console.log(
    result.modifiedCount === 0
      ? "Every account is already marked verified. Nothing to do."
      : `Marked ${result.modifiedCount} existing account${
          result.modifiedCount === 1 ? "" : "s"
        } as verified.`,
  );

  const total = await User.countDocuments({ emailVerified: true });
  console.log(`${total} of ${await User.countDocuments()} accounts are verified.`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Could not update accounts: ", err.message);
  process.exit(1);
});
