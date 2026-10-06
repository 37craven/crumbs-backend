const HttpError = require("../utils/httpError");

const OBJECT_ID = /^[a-f\d]{24}$/i;

// Used with router.param so every route containing the named parameter has it
// checked before the handler runs. Without this, an id like "abc" would reach
// Mongoose and surface as a confusing CastError.
//
//   router.param("id", validateObjectIdParam);
function validateObjectIdParam(req, res, next, value, name) {
  if (!OBJECT_ID.test(value)) {
    return next(new HttpError(400, `Invalid ${name}`));
  }
  next();
}

module.exports = { validateObjectIdParam, OBJECT_ID };
