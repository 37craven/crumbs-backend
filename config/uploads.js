const path = require("node:path");

// Uploaded pictures live inside the documents that own them (see models/Image.js),
// so there is no folder to configure and nothing to back up separately.
//
// Where uploads/ used to be, kept ONLY so the one-off migration scripts can find
// pictures saved before the move. Nothing in the running app reads this.
const LEGACY_UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(__dirname, "..", "uploads"),
);

const MAX_FILE_SIZE = 4 * 1024 * 1024; // 4 MB per image

// Profile photos are resized to a small square by the client before upload,
// so they get a much tighter limit than collection pictures.
const MAX_AVATAR_SIZE = 1024 * 1024; // 1 MB

// Allowed image types. The bytes are stored and served back with the type they
// arrived as, so this is the only place a picture's content type is decided.
// SVG is deliberately missing: an SVG can contain scripts.
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

module.exports = {
  LEGACY_UPLOAD_DIR,
  MAX_FILE_SIZE,
  MAX_AVATAR_SIZE,
  ALLOWED_IMAGE_TYPES,
};
