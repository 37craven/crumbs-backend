const express = require("express");
const mongoose = require("mongoose");
const { z } = require("zod");
const Crumb = require("../models/Crumb");
const { requireAuth } = require("../middleware/auth");
const { rawImage, sniffImageType } = require("../middleware/image");

const router = express.Router();

const receiveImage = rawImage(3 * 1024 * 1024, "Image is too large (3 MB max)");

const captionSchema = z
  .string()
  .trim()
  .max(60, "Caption must be at most 60 characters");

router.get("/", requireAuth, async (req, res) => {
  const crumbs = await Crumb.find({ user: req.user._id }).sort({
    createdAt: -1,
  });

  res.json({ crumbs: crumbs.map((crumb) => crumb.toPublic()) });
});

router.post("/", requireAuth, receiveImage, async (req, res) => {
  const image = Buffer.isBuffer(req.body) ? req.body : null;
  const contentType = image && sniffImageType(image);

  if (!contentType) {
    return res
      .status(400)
      .json({ message: "Upload a JPEG, PNG or WebP image" });
  }

  const rawCaption =
    typeof req.query.caption === "string" ? req.query.caption : "";
  const caption = captionSchema.safeParse(rawCaption);

  if (!caption.success) {
    const message = caption.error.issues[0].message;
    return res.status(400).json({ message, fields: { caption: [message] } });
  }

  const crumb = await Crumb.create({
    user: req.user._id,
    imageData: image,
    contentType,
    caption: caption.data,
  });

  res.status(201).json({ crumb: crumb.toPublic() });
});

router.get("/:id/image", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).end();
  }

  const crumb = await Crumb.findById(req.params.id).select("+imageData");
  if (!crumb) {
    return res.status(404).end();
  }

  res.set({
    "Content-Type": crumb.contentType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(Buffer.from(crumb.imageData));
});

module.exports = router;