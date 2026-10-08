const crypto = require("node:crypto");
const fs = require("node:fs");
const multer = require("multer");
const HttpError = require("../utils/httpError");
const {
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  ALLOWED_IMAGE_TYPES,
} = require("../config/uploads");

const storage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  // A random name means two users uploading "photo.jpg" never collide and a
  // hostile file name can never escape the upload folder.
  filename(req, file, cb) {
    cb(null, `${crypto.randomUUID()}${ALLOWED_IMAGE_TYPES.get(file.mimetype)}`);
  },
});

function fileFilter(req, file, cb) {
  if (ALLOWED_IMAGE_TYPES.has(file.mimetype)) return cb(null, true);
  cb(new HttpError(400, "Only JPEG, PNG, WebP and GIF images are allowed"));
}

// Accepts ONE picture in a multipart field named "image".
const uploadImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
}).single("image");

module.exports = { uploadImage };
