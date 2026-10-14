// One-off. Folds crumbs written by the old picture-in-document layout into the
// `image` subdocument every picture now uses.
//
// Before this, a crumb carried loose top-level fields — `filename` and `url`
// pointing at a file in uploads/, or on the earliest iteration `imageData` (a
// Mongo Buffer) with a `contentType`. Pictures now live inside an `image`
// subdocument (see models/Image.js), so a record and its picture travel together.
//
// This handles both old shapes: a crumb holding `imageData` gets those bytes
// moved into `image.data`, and a crumb still pointing at a file in uploads/ has
// that file read and moved in. It is safe to run twice — a crumb that already has
// an `image` is left alone.
//
//   npm run migrate:crumbs
//
// Run `npm run prune` afterwards to delete the now-unreferenced files left in
// uploads/, then the folder can be removed from .gitignore and deleted.

const fs = require("node:fs/promises");
const path = require("node:path");
const mongoose = require("mongoose");

process.loadEnvFile();

const { LEGACY_UPLOAD_DIR } = require("../config/uploads");
const Crumb = require("../models/Crumb");
const { ALLOWED_IMAGE_TYPES } = require("../config/uploads");

// A picture stored in a document comes back from MongoDB as BSON Binary, whose
// `length` is a METHOD (it returns `position`) and whose `buffer` may be a
// larger pooled ArrayBuffer than the data actually uses. `value(true)` is the
// exact bytes; the fallbacks are for a plain Buffer or BufferJSON.
function readBytes(stored) {
  if (Buffer.isBuffer(stored)) return stored;
  if (typeof stored?.value === "function") return Buffer.from(stored.value(true));
  if (stored?.buffer) {
    return Buffer.from(stored.buffer).subarray(
      0,
      stored.position ?? stored.length ?? stored.buffer.length,
    );
  }
  return Buffer.from(stored);
}

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Both old shapes at once: bytes loose in the document, or a file on disk.
  const legacy = await Crumb.collection
    .find({
      image: { $exists: false },
      $or: [{ imageData: { $exists: true } }, { filename: { $exists: true } }],
    })
    .toArray();

  if (legacy.length === 0) {
    console.log("No legacy crumbs. Nothing to do.");
    return;
  }

  let moved = 0;
  let skipped = 0;

  for (const crumb of legacy) {
    let bytes = null;
    let mimeType = null;

    if (crumb.imageData) {
      // Oldest shape: the bytes were already in the document.
      mimeType = crumb.contentType;
      bytes = readBytes(crumb.imageData);
    } else {
      // Middle shape: a file in uploads/. Only its name was ever in the database,
      // so the bytes have to be read back from disk.
      mimeType = crumb.mimeType;
      try {
        bytes = await fs.readFile(path.join(LEGACY_UPLOAD_DIR, path.basename(crumb.filename)));
      } catch (err) {
        console.warn(`  skipped ${crumb._id}: ${crumb.filename} could not be read (${err.code})`);
        skipped += 1;
        continue;
      }
    }

    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      console.warn(`  skipped ${crumb._id}: ${mimeType ?? "no content type"} is not an allowed image type`);
      skipped += 1;
      continue;
    }

    await Crumb.collection.updateOne(
      { _id: crumb._id },
      {
        $set: {
          image: {
            data: bytes,
            originalName: crumb.originalName ?? "",
            mimeType,
            size: bytes.length,
            uploadedAt: crumb.createdAt ?? new Date(),
          },
        },
        // The old fields go only once the bytes are safely inside the document.
        $unset: { imageData: "", contentType: "", filename: "", url: "", mimeType: "", size: "" },
      },
    );

    console.log(`  moved ${crumb._id} -> image subdocument (${bytes.length} bytes)`);
    moved += 1;
  }

  console.log(`\nMoved ${moved} crumb${moved === 1 ? "" : "s"} into their documents.`);
  if (skipped > 0) {
    console.log(
      `${skipped} left untouched: their picture could not be read or is no longer an allowed ` +
        "image type. They still need migrating by hand, or deleting.",
    );
  }
}

migrate()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
