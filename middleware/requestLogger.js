// Logs one line per request once the response has been sent:
//   GET /api/collections 200 12ms
function requestLogger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    if (process.env.NODE_ENV === "test") return; // keep test output clean
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(0)}ms`,
    );
  });

  next();
}

module.exports = requestLogger;
