// One-off. Moves crumbs written by the old Buffer-in-Mongo model onto disk.
//
// Before this, a crumb stored its picture in the document as `imageData` (a
// Mongo Buffer) plus `contentType`, and was served from /api/crumbs/:id/image.
// It now stores a file in uploads/ like every other picture, and carries
// `url`. Old documents have no `url`, so the API returned imageUrl: undefined
// and the client rejected the whole list.
//
// This writes those pictures to disk, points each crumb at its file, and drops
// the old fields. It is safe to run twice: a crumb that already has a url is
// left alone.
//
//   npm run migrate:crumbs
//
// Nothing here is undone automatically. Keep a copy of the database if the old
// Buffer form matters to you.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const mongoose = require("mongoose");

process.loadEnvFile();

const Crumb = require("../models/Crumb");
const { UPLOAD_DIR } = require("../config/uploads");
const { ALLOWED_IMAGE_TYPES } = require("../config/uploads");
const { assertSafeDatabase } = require("../config/database");

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
  assertSafeDatabase(process.env.MONGODB_URI ?? "");

  const legacy = await Crumb.collection
    .find({ imageData: { $exists: true } })
    .toArray();

  if (legacy.length === 0) {
    console.log("No legacy crumbs. Nothing to do.");
    return;
  }

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

  let moved = 0;
  let skipped = 0;

  for (const crumb of legacy) {
    const mimeType = crumb.contentType;

    // An extension only ever comes from this table, never from stored data.
    const extension = ALLOWED_IMAGE_TYPES.get(mimeType);
    if (!extension) {
      console.warn(
        `  skipped ${crumb._id}: ${mimeType ?? "no content type"} is not an allowed image type`,
      );
      skipped += 1;
      continue;
    }

    const bytes = readBytes(crumb.imageData);

    const filename = `${crypto.randomUUID()}${extension}`;
    await fs.writeFile(path.join(UPLOAD_DIR, filename), bytes);

    await Crumb.collection.updateOne(
      { _id: crumb._id },
      {
        $set: {
          filename,
          url: `/uploads/${filename}`,
          mimeType,
          size: bytes.length,
        },
        // The old fields go only after the file is safely on disk.
        $unset: { imageData: "", contentType: "" },
      },
    );

    console.log(`  moved ${crumb._id} -> ${filename} (${bytes.length} bytes)`);
    moved += 1;
  }

  console.log(`\nMoved ${moved} crumb${moved === 1 ? "" : "s"} to ${UPLOAD_DIR}.`);
  if (skipped > 0) {
    console.log(
      `${skipped} left untouched: their picture type is no longer allowed. ` +
        "They still need migrating by hand, or deleting.",
    );
  }
}

migrate()
  .then(() => mongoose.disconnect())
  .catch((err) => {
    console.error("Migration failed: ", err.message);
    process.exitCode = 1;
    mongoose.disconnect();
  });
