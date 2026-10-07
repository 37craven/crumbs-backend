const multer = require("multer");
const HttpError = require("../utils/httpError");
const { MAX_FILE_SIZE } = require("../config/uploads");

// Turns any error into the one JSON shape the API uses:
//   { "message": "...", "fields": { "title": ["..."] } }   (fields is optional)
// Must be registered LAST, after the 404 catch-all.
// Express recognises an error handler by its four parameters, so `next`
// has to stay in the signature even though it is rarely used.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  // Errors we throw on purpose (404, 409, validation failures...).
  if (err instanceof HttpError) {
    const body = { message: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }

  // Mongoose schema validation failed (required, maxlength, enum...).
  if (err.name === "ValidationError" && err.errors) {
    const fields = {};
    for (const [path, problem] of Object.entries(err.errors)) {
      fields[path] = [problem.message];
    }
    return res.status(400).json({ message: "Validation failed", fields });
  }

  // A value could not be converted to the schema type (e.g. a bad ObjectId).
  if (err.name === "CastError") {
    return res.status(400).json({ message: `Invalid ${err.path}` });
  }

  // Unique index violated.
  if (err.code === 11000) {
    return res.status(409).json({ message: "That record already exists" });
  }

  // Someone else saved the same document between our read and our write.
  if (err.name === "VersionError") {
    return res.status(409).json({
      message: "This record was changed elsewhere. Reload and try again.",
    });
  }

  // Bad request bodies caught by express.json().
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ message: "Request body is not valid JSON" });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ message: "Request body is too large" });
  }

  // Upload problems caught by multer.
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      // Avatars are capped lower than collection pictures, so report the limit
      // multer actually enforced rather than a fixed number.
      const mb = Math.round((err.limit ?? MAX_FILE_SIZE) / (1024 * 1024));
      return res.status(413).json({ message: `Each image must be ${mb} MB or less` });
    }
    return res.status(400).json({ message: `Upload rejected: ${err.message}` });
  }

  // Anything else is a bug. Log the details, show the client nothing sensitive.
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
}

module.exports = errorHandler;
