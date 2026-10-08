const express = require("express");
const { rateLimit } = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const { parseOrThrow } = require("../validators/common");
const { linkPreviewSchema } = require("../validators/widget");
const { buildLinkData } = require("../services/linkPreview");

const router = express.Router();

// Each preview makes our server fetch a third-party page, so keep it bounded.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many link previews, try again in a minute" },
});

// POST /api/links/preview — look up a link without saving it, so the Add Event
// page can show the thumbnail as soon as the user pastes the address.
// Body: { "url": "https://..." }
router.post("/preview", requireAuth, previewLimiter, async (req, res) => {
  const { url } = parseOrThrow(linkPreviewSchema, req.body);
  res.json({ link: await buildLinkData(url) });
});

module.exports = router;
