const express = require("express");
const Crumb = require("../models/Crumb");
const { requireAuth } = require("../middleware/auth");
const { uploadImage } = require("../middleware/upload");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const HttpError = require("../utils/httpError");
const { parseOrThrow } = require("../validators/common");
const { createCrumbSchema } = require("../validators/crumb");
const { createCrumb, removeFileUnlessShared } = require("../services/crumbs");

const router = express.Router();

// Every crumb route belongs to the signed-in user alone.
router.use(requireAuth);
router.param("id", validateObjectIdParam); // reject malformed ids with a 400

// GET /api/crumbs — my crumbs, newest first.
router.get("/", async (req, res) => {
  const crumbs = await Crumb.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .lean();

  res.json({ crumbs: crumbs.map((crumb) => new Crumb(crumb).toPublic()) });
});

// POST /api/crumbs — upload a photo (multipart/form-data, field "image") with
// an optional `caption` and an optional `collectionId`. When a collection is
// given, the same picture also lands in that collection as an image widget.
//
// The file is on disk before this handler runs, so a failure deletes it again.
router.post("/", uploadImage, async (req, res) => {
  const file = req.file;
  // Multer has already written the file by the time this runs, so any failure
  // from here on — a bad caption, a refused collection, a database error —
  // has to take the file with it.
  let kept = false;

  try {
    if (!file) {
      throw new HttpError(
        400,
        'No image received. Send it as multipart/form-data in the field "image".',
      );
    }

    const { caption, collectionId } = parseOrThrow(createCrumbSchema, req.body);

    const { crumb, widget, copyError } = await createCrumb(req.user, file, {
      caption,
      collectionId: collectionId ?? null,
    });
    kept = true;

    res.status(201).json({
      crumb: crumb.toPublic(),
      // Set when the crumb was saved but the collection copy was refused, so
      // the client can say so instead of silently losing the collection.
      collectionCopyError: copyError ? copyError.message : null,
      filedInCollection: Boolean(widget),
    });
  } catch (err) {
    if (file && !kept) await removeFileUnlessShared(file.filename);
    throw err;
  }
});

// DELETE /api/crumbs/:id — remove one of my crumbs. A copy filed in a
// collection keeps its own widget and the shared file on disk.
router.delete("/:id", async (req, res) => {
  const crumb = await Crumb.findOne({ _id: req.params.id, user: req.user._id });
  if (!crumb) throw new HttpError(404, "Crumb not found");

  await Crumb.deleteOne({ _id: crumb._id });
  await removeFileUnlessShared(crumb.filename);

  res.json({ message: "Crumb deleted", id: crumb._id.toString() });
});

module.exports = router;
