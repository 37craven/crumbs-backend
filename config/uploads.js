const path = require("node:path");

// Where uploaded images are stored on disk. Override with UPLOAD_DIR in .env.
const UPLOAD_DIR = path.resolve(
  process.env.UPLOAD_DIR ?? path.join(__dirname, "..", "uploads"),
);

// The URL path the files are served from (see app.js).
const PUBLIC_UPLOAD_PATH = "/uploads";

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB per image

// Allowed image types and the file extension we give each one. The extension
// comes from this table, never from the user's file name.
// SVG is deliberately missing: an SVG can contain scripts.
const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

module.exports = {
  UPLOAD_DIR,
  PUBLIC_UPLOAD_PATH,
  MAX_FILE_SIZE,
  ALLOWED_IMAGE_TYPES,
};
