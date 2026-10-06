// An error that carries an HTTP status code. Throw it from any route or
// service; middleware/errorHandler.js turns it into a JSON response.
//
//   throw new HttpError(404, "Event not found");
//   throw new HttpError(400, "Validation failed", { title: ["Title is required"] });
class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.fields = fields;
  }
}

module.exports = HttpError;
