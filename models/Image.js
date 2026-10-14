const mongoose = require("mongoose");

const { Schema } = mongoose;

// One uploaded picture, held inside the document it belongs to.
//
// The bytes used to live on disk under uploads/ while only the file name went into
// the database. That split made the database only half the picture: a fresh clone,
// another machine or a rebuilt sandbox had every record pointing at a file that was
// not there, so the tiles were simply blank. Keeping the bytes with the record means
// the two travel together and are restored together.
//
// `data` is select:false, so an ordinary query never drags megabytes along. Lists and
// payloads that carry a picture read only its name and size; the route that serves the
// image asks for this one field back by name. MAX_FILE_SIZE in config/uploads.js caps
// what can arrive here, which keeps a document well inside MongoDB's 16 MB ceiling.
const imageSchema = new Schema(
  {
    data: { type: Buffer, required: true, select: false },
    originalName: { type: String, trim: true, maxlength: 255, default: "" },
    mimeType: { type: String, required: true },
    size: { type: Number, min: 0, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

// Builds the subdocument from a multer memory-storage upload.
function imageFromUpload(file) {
  return {
    data: file.buffer,
    originalName: (file.originalname ?? "").slice(0, 255),
    mimeType: file.mimetype,
    size: file.size,
    uploadedAt: new Date(),
  };
}

// Where a stored picture is served from. Relative on purpose: the web client puts its
// own API origin in front of a relative path (see assetUrl in crumbs/src/lib/api.ts).
//
// Unlike the old /uploads/<random-uuid> address, this one is the same every time, so a
// replaced picture keeps its URL. Anything caching these has to revalidate, which is why
// sendImage() in services/images.js answers with an ETag instead of a long max-age.
const imagePathFor = (kind, id) => `/api/${kind}/${id}/image`;

// A profile photo is not an "image" subroute, so it gets its own address.
const avatarPathFor = (userId) => `/api/users/${userId}/avatar`;

module.exports = { imageSchema, imageFromUpload, imagePathFor, avatarPathFor };
