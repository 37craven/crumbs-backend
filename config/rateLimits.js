// Rate limiters for the routes that send mail or guess tokens.
//
// They apply in PRODUCTION only.
//
// Everything else gets a pass-through. Rate limiting is there to slow down
// someone hammering the public API from the internet; on a development machine
// there is exactly one caller (you) and a shared address, so a limiter does
// nothing useful and instead eats the budget that a test run, the smoke script
// or your own next request would then need. The sandbox is already protected by
// CORS being pinned to CLIENT_ORIGIN.
//
// `passthrough` keeps the middleware in the chain, so the route still runs
// normally and nothing has to know which mode it is in.
const { rateLimit } = require("express-rate-limit");
const passthrough = (_req, _res, next) => next();

const LIMITING = process.env.NODE_ENV === "production";

function limiter(windowMs, limit, message) {
  if (!LIMITING) return passthrough;

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message },
  });
}

module.exports = { limiter, LIMITING };
