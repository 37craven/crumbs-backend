const multer = require("multer");
const HttpError = require("../utils/httpError");
const { MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES } = require("../config/uploads");

// Memory storage, not disk.
//
// Pictures used to be written to uploads/ and the database kept only the file name,
// which meant the database could not restore a picture on its own. The bytes are now
// kept in the document (see models/Image.js), so multer holds the upload in memory
// and the handler puts it straight into the record.
//
// In memory is affordable here because config/uploads.js caps an upload at 5 MB, and
// only one file is accepted. Nothing is ever left on disk, so a request that fails
// halfway no longer needs the file cleaned up afterwards.
const storage = multer.memoryStorage();

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

// Same as uploadImage but capped at `bytes`. Profile photos are small square
// crops the client has already resized, so they get a tighter limit than the
// 5 MB collection pictures.
function imageUploader(bytes) {
  return multer({
    storage,
    fileFilter,
    limits: { fileSize: bytes, files: 1 },
  }).single("image");
}

module.exports = { uploadImage, imageUploader };
