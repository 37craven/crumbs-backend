// Catch-all for any URL no route handled. Must be registered AFTER all routes
// and BEFORE the error handler.
function notFound(req, res) {
  res
    .status(404)
    .json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = notFound;
