// One-off. Moves pictures out of the uploads/ folder and into the documents that
// own them (see models/Image.js).
//
// Run this once, on a machine that still HAS the uploads/ folder, after upgrading
// to picture-in-document storage. It covers all three places a picture used to be
// named on disk: crumbs, image widgets and profile photos.
//
//   npm run migrate:images
//
// Anything whose file is already gone cannot be recovered and is reported, not
// silently dropped — those records keep their old fields and are listed so they
// can be deleted or replaced by hand.
//
// Safe to run twice: a document that already has an `image` is skipped.

const fs = require("node:fs/promises");
const path = require("node:path");
const mongoose = require("mongoose");

process.loadEnvFile();

const { LEGACY_UPLOAD_DIR } = require("../config/uploads");
const Crumb = require("../models/Crumb");
const Collection = require("../models/Collection");
const { Widget } = require("../models/Widget");
const User = require("../models/User");

const REPORT = [];
const note = (kind, id, what) => REPORT.push({ kind, id, what });

// Reads a stored file, refusing anything that tries to point outside the folder.
async function readStored(name) {
  if (!name) return null;
  try {
    return await fs.readFile(path.join(LEGACY_UPLOAD_DIR, path.basename(name)));
  } catch {
    return null;
  }
}

function subdoc(bytes, { originalName, mimeType, uploadedAt }) {
  return {
    data: bytes,
    originalName: originalName ?? "",
    mimeType,
    size: bytes.length,
    uploadedAt: uploadedAt ?? new Date(),
  };
}

// ---- crumbs -----------------------------------------------------------------
async function migrateCrumbs() {
  const stale = await Crumb.collection
    .find({ image: { $exists: false }, filename: { $exists: true } })
    .toArray();

  for (const doc of stale) {
    const bytes = await readStored(doc.filename);
    if (!bytes) {
      note("crumb", doc._id, `uploads/${doc.filename} is missing`);
      continue;
    }
    await Crumb.collection.updateOne(
      { _id: doc._id },
      {
        $set: { image: subdoc(bytes, doc) },
        $unset: { filename: "", url: "", mimeType: "", size: "" },
      },
    );
    note("crumb", doc._id, `moved ${bytes.length} bytes in`);
  }
  return stale.length;
}

// ---- image widgets ----------------------------------------------------------
async function migrateWidgets() {
  const stale = await Widget.collection
    .find({ type: "image", "image.filename": { $exists: true } })
    .toArray();

  for (const doc of stale) {
    const bytes = await readStored(doc.image.filename);
    if (!bytes) {
      note("widget", doc._id, `uploads/${doc.image.filename} is missing`);
      continue;
    }
    await Widget.collection.updateOne(
      { _id: doc._id },
      {
        // Assigning the whole subdocument replaces it, so the old `filename` and
        // `url` inside it go with it. Unsetting a child of a path being assigned
        // in the same update is a conflict, so there is deliberately no $unset here.
        $set: { "image": subdoc(bytes, doc.image) },
      },
    );
    note("widget", doc._id, `moved ${bytes.length} bytes in`);
  }
  return stale.length;
}

// ---- profile photos ---------------------------------------------------------
async function migrateAvatars() {
  const stale = await User.collection
    .find({ "avatar.filename": { $exists: true } })
    .toArray();

  for (const doc of stale) {
    const bytes = await readStored(doc.avatar.filename);
    if (!bytes) {
      note("avatar", doc._id, `uploads/${doc.avatar.filename} is missing`);
      continue;
    }
    await User.collection.updateOne(
      { _id: doc._id },
      {
        // As with widgets: assigning the subdocument replaces it whole, and the
        // old `filename`/`url` inside it disappear with it.
        $set: { "avatar": subdoc(bytes, doc.avatar) },
      },
    );
    note("avatar", doc._id, `moved ${bytes.length} bytes in`);
  }
  return stale.length;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);

  const found = {
    crumbs: await migrateCrumbs(),
    widgets: await migrateWidgets(),
    avatars: await migrateAvatars(),
  };

  console.log(
    `\nFound ${found.crumbs} crumb(s), ${found.widgets} image widget(s) and ` +
      `${found.avatars} profile photo(s) still pointing at uploads/.`,
  );

  const moved = REPORT.filter((r) => r.what.startsWith("moved"));
  const lost = REPORT.filter((r) => !r.what.startsWith("moved"));

  for (const r of moved) console.log(`  moved   ${r.kind.padEnd(7)} ${r.id}  ${r.what}`);
  for (const r of lost) console.log(`  MISSING ${r.kind.padEnd(7)} ${r.id}  ${r.what}`);

  console.log(`\nMoved ${moved.length}, could not recover ${lost.length}.`);
  if (lost.length > 0) {
    console.log(
      "The unrecovered records still point at a file that is gone, so their picture " +
        "will not render. Re-upload or delete them by hand; the ids are listed above.",
    );
  }

  // A collection's card copies picture addresses into its summary, so the stale
  // ones have to be rebuilt from the widgets that now hold the bytes.
  const touched = await Collection.collection
    .find({ "summary.imageUrls.0": { $exists: true } })
    .toArray();
  if (touched.length > 0) {
    const { refreshCollectionSummary } = require("../services/collectionSummary");
    for (const c of touched) await refreshCollectionSummary(c._id);
    console.log(`Rebuilt the card summary of ${touched.length} collection(s).`);
  }

  console.log(
    "\nDone. uploads/ can now be deleted, and the `uploads` line removed from .gitignore.",
  );
}

run()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
