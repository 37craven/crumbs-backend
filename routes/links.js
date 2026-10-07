const express = require("express");
const { limiter } = require("../config/rateLimits");
const { requireAuth } = require("../middleware/auth");
const { parseOrThrow } = require("../validators/common");
const { linkPreviewSchema } = require("../validators/widget");
const { buildLinkData } = require("../services/linkPreview");

const router = express.Router();

// Each preview makes our server fetch a third-party page, so keep it bounded.
// Same production-only rule as the other limiters: off in development.
const previewLimiter = limiter(
  60 * 1000,
  30,
  "Too many link previews, try again in a minute",
);

// POST /api/links/preview — look up a link without saving it, so the Add Collection
// page can show the thumbnail as soon as the user pastes the address.
// Body: { "url": "https://..." }
router.post("/preview", requireAuth, previewLimiter, async (req, res) => {
  const { url } = parseOrThrow(linkPreviewSchema, req.body);
  res.json({ link: await buildLinkData(url) });
});

module.exports = router;
