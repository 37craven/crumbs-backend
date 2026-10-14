// Removes the accounts that testing left behind, and everything that belongs to
// them.
//
//   npm run prune                  -> dry run: reports, deletes nothing
//   npm run prune -- --apply       -> actually delete
//   npm run prune -- --apply --include-seed
//
// Test leftovers (smoke_*, ann_*, ben_*) are the default because nothing else
// refers to them. The seed accounts (demo, mika, jon, ana) are NOT: they own
// every collection and widget in the sandbox, so removing them empties the app.
// They need --include-seed, deliberately.
//
// Like reset-sandbox.js, this refuses to touch anything but the sandbox.

process.loadEnvFile();

const fs = require("node:fs/promises");
const path = require("node:path");
const mongoose = require("mongoose");

const { SANDBOX_DB_NAME, getDatabaseName } = require("../config/database");

const APPLY = process.argv.includes("--apply");
const INCLUDE_SEED = process.argv.includes("--include-seed");

// Matches whole usernames, not substrings, so `demo` cannot catch `demolition`
// and `ann_*` cannot catch a real person called `anna`.
const TEST_PATTERNS = [/^smoke_/, /^ann_/, /^ben_/, /^tmpcheck/];
const SEED_USERNAMES = ["demo", "mika", "jon", "ana"];

/** Accounts this script will never remove, whatever the patterns say. */
const PROTECTED = ["craven"];

function isRemovable(user, protectedIds) {
  if (protectedIds.has(user._id.toString())) return false;
  if (TEST_PATTERNS.some((re) => re.test(user.username))) return true;
  return INCLUDE_SEED && SEED_USERNAMES.includes(user.username);
}

async function prune() {
  const dbName = getDatabaseName(process.env.MONGODB_URI ?? "");
  if (dbName !== SANDBOX_DB_NAME) {
    console.error(
      `Refusing to prune: MONGODB_URI points at "${dbName}", not the sandbox "${SANDBOX_DB_NAME}".`,
    );
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const ids = (v) => v.map((x) => x.toString());
  const tally = {};

  // ---- Who goes -------------------------------------------------------------
  const users = await db.collection("users").find({}).toArray();
  const protectedIds = new Set(
    users.filter((u) => PROTECTED.includes(u.username)).map((u) => u._id.toString()),
  );
  const doomed = users.filter((u) => isRemovable(u, protectedIds));
  // Two forms of the same set, and the difference matters: this driver does not
  // cast a query value, so `{ user: { $in: ["6abf…"] } }` silently matches
  // nothing at all against an ObjectId field. Strings for comparing in JS,
  // ObjectIds for every query below.
  const doomedIds = new Set(doomed.map((u) => u._id.toString()));
  const doomedRef = doomed.map((u) => u._id);

  if (doomed.length === 0) {
    console.log("Nothing matched. No accounts removed.");
    await mongoose.disconnect();
    return;
  }

  const byPattern = {};
  for (const user of doomed) {
    const key = user.username.replace(/_.*/, "_*");
    byPattern[key] = (byPattern[key] ?? 0) + 1;
  }
  console.log(`${doomed.length} account(s) matched:`);
  for (const [pattern, count] of Object.entries(byPattern).sort()) {
    console.log(`  ${String(count).padStart(3)}  ${pattern}`);
  }
  console.log(
    `  kept: ${users
      .filter((u) => !doomedIds.has(u._id.toString()))
      .map((u) => u.username)
      .join(", ")}\n`,
  );

  // ---- What goes with them --------------------------------------------------
  // Collections come in two kinds and they are not treated the same. One a
  // removed person OWNS is gone with them. One they merely collaborated on
  // belongs to somebody who is still here, so it survives with them taken off
  // it — deleting it would throw away another person's collection.
  const collections = await db.collection("collections").find({}).toArray();
  const ownedIds = collections
    .filter((c) => doomedIds.has(c.owner.toString()))
    .map((c) => c._id.toString());
  const touchedIds = collections
    .filter(
      (c) =>
        !ownedIds.includes(c._id.toString()) &&
        (c.collaborators ?? []).some((id) => doomedIds.has(id.toString())),
    )
    .map((c) => c._id.toString());
  // Same two forms as above: the string ids to compare in JS, the real ids for
  // the queries. Getting this backwards deletes nothing and reports nothing.
  const ownedRef = ownedIds.map((id) => new mongoose.Types.ObjectId(id));
  const touchedRef = touchedIds.map((id) => new mongoose.Types.ObjectId(id));

  const crumbs = await db
    .collection("crumbs")
    .find({ user: { $in: doomedRef } })
    .toArray();
  const friendships = await db
    .collection("friendships")
    .find({ $or: [{ requester: { $in: doomedRef } }, { recipient: { $in: doomedRef } }] })
    .toArray();
  // The pre-rename collection of the same name. Nothing reads it; it is kept in
  // step with `collections` so the two cannot drift further apart.
  const legacyEvents = await db
    .collection("events")
    .find({ owner: { $in: doomedRef } })
    .toArray();
  const legacyRef = legacyEvents.map((c) => c._id);

  // Widgets come in two shapes here. The current one hangs off `collectionId`;
  // the older one hangs off `event`, which points into `events`. Both have to go
  // with their collection, or deleting the `events` documents would strand the
  // widgets that reference them — which the app cannot even see, since nothing
  // reads that field any more.
  const widgetsNow = await db
    .collection("widgets")
    .countDocuments({ collectionId: { $in: ownedRef } });
  const widgetsLegacy = await db
    .collection("widgets")
    .countDocuments({ event: { $in: legacyRef } });
  const widgets = widgetsNow + widgetsLegacy;
  const legacy = legacyEvents.length;

  // Pictures to count, not to delete: they live inside the documents that own
  // them (see models/Image.js), so removing the documents removes them too.
  const images =
    crumbs.filter((c) => c.image || c.imageData).length +
    doomed.filter((u) => u.avatar).length;

  tally.users = doomed.length;
  tally.collections = ownedIds.length;
  tally.recollections = touchedIds.length;
  tally.widgets = widgets;
  tally.crumbs = crumbs.length;
  tally.friendships = friendships.length;
  tally.legacyEvents = legacy;
  tally.files = images;

  console.log("Cascade:");
  console.log(`  ${String(ownedIds.length).padStart(3)}  collections owned (deleted)`);
  console.log(`  ${String(widgets).padStart(3)}  widgets inside them (deleted: ${widgetsNow} by collectionId, ${widgetsLegacy} legacy)`);
  console.log(`  ${String(touchedIds.length).padStart(3)}  collections shared with them (kept, collaborator removed)`);
  console.log(`  ${String(crumbs.length).padStart(3)}  crumbs (deleted)`);
  console.log(`  ${String(friendships.length).padStart(3)}  friendships (deleted)`);
  console.log(`  ${String(legacy).padStart(3)}  legacy 'events' documents (deleted)`);
  console.log(`  ${String(images).padStart(3)}  pictures held inside them (deleted with them)\n`);

  if (touchedIds.length > 0) {
    for (const c of collections.filter((x) => touchedIds.includes(x._id.toString()))) {
      console.log(`  kept: "${c.title}" (owner still here, collaborator removed)`);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run. Nothing was deleted. Re-run with --apply to do it.");
    await mongoose.disconnect();
    return;
  }

  // ---- Delete ---------------------------------------------------------------
  // Collections first, so a widget can never outlive the row it hangs from.
  if (ownedIds.length) {
    await db
      .collection("widgets")
      .deleteMany({ $or: [{ collectionId: { $in: ownedRef } }, { event: { $in: legacyRef } }] });
    await db.collection("collections").deleteMany({ _id: { $in: ownedRef } });
  }
  if (touchedIds.length) {
    await db.collection("collections").updateMany(
      { _id: { $in: touchedRef } },
      { $pull: { collaborators: { $in: doomedRef } } },
    );
  }
  await db.collection("events").deleteMany({ owner: { $in: doomedRef } });
  await db.collection("crumbs").deleteMany({ user: { $in: doomedRef } });
  await db
    .collection("friendships")
    .deleteMany({
      $or: [{ requester: { $in: doomedRef } }, { recipient: { $in: doomedRef } }],
    });
  await db.collection("users").deleteMany({ _id: { $in: doomedRef } });

  // Nothing else to clean up: pictures live inside the documents just removed.

  const left = await db.collection("users").countDocuments();
  console.log(
    `Done. ${tally.users} accounts removed, ${left} left in ${dbName}.`,
  );
  await mongoose.disconnect();
}

prune().catch((err) => {
  console.error("Prune failed: ", err.message);
  process.exit(1);
});