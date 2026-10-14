const express = require("express");
const Crumb = require("../models/Crumb");
const { requireAuth } = require("../middleware/auth");
const { uploadImage } = require("../middleware/upload");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const { sendImage } = require("../services/images");
const { isFriend, getFriendIds } = require("../services/friends");
const HttpError = require("../utils/httpError");
const { parseOrThrow } = require("../validators/common");
const { createCrumbSchema } = require("../validators/crumb");
const { createCrumb } = require("../services/crumbs");

const router = express.Router();

router.param("id", validateObjectIdParam); // reject malformed ids with a 400

// Every crumb route needs a logged-in user. The picture route below used to sit
// above this check, when pictures were public files anyone could fetch by name.
// They are now served from here and follow the same rule as the crumb itself:
// only the owner and their accepted friends may see one.
router.use(requireAuth);

// GET /api/crumbs/:id/image — the crumb's picture.
//
// A crumb you are not friends with gets the same 404 a missing crumb gets, so
// photos cannot be probed for existence by id. The id is a 12-byte ObjectId, and
// the response revalidates on an ETag rather than being cached for good.
router.get("/:id/image", async (req, res) => {
  // `+image.data` because the bytes are select:false on every ordinary query.
  const crumb = await Crumb.findById(req.params.id).select("+image.data +imageData");

  const mine = crumb && String(crumb.user) === String(req.user._id);
  const visible = crumb && (mine || (await isFriend(req.user._id, crumb.user)));
  if (!visible) throw new HttpError(404, "Crumb not found");

  return sendImage(req, res, crumb.picture());
});

// GET /api/crumbs — my crumbs, newest first.
// GET /api/crumbs?scope=all — my crumbs plus friends', newest first.
router.get("/", async (req, res) => {
  const scope = req.query.scope === "all" ? "all" : "mine";

  let crumbs;
  if (scope === "all") {
    const friendIds = await getFriendIds(req.user._id);
    const userIds = [req.user._id.toString(), ...friendIds];
    crumbs = await Crumb.find({ user: { $in: userIds } })
      .sort({ createdAt: -1 })
      .lean();
  } else {
    crumbs = await Crumb.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .lean();
  }

  res.json({ crumbs: crumbs.map((crumb) => new Crumb(crumb).toPublic()) });
});

// POST /api/crumbs — upload a photo (multipart/form-data, field "image") with
// an optional `caption` and an optional `collectionId`. When a collection is
// given, the same picture also lands in that collection as an image widget.
router.post("/", uploadImage, async (req, res) => {
  const file = req.file;
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

  res.status(201).json({
    crumb: crumb.toPublic(),
    // Set when the crumb was saved but the collection copy was refused, so
    // the client can say so instead of silently losing the collection.
    collectionCopyError: copyError ? copyError.message : null,
    filedInCollection: Boolean(widget),
  });
});

// DELETE /api/crumbs/:id — remove one of my crumbs, and the picture it holds. A
// copy filed in a collection keeps its own widget and its own copy of the picture.
router.delete("/:id", async (req, res) => {
  const crumb = await Crumb.findOne({ _id: req.params.id, user: req.user._id });
  if (!crumb) throw new HttpError(404, "Crumb not found");

  await Crumb.deleteOne({ _id: crumb._id });

  res.json({ message: "Crumb deleted", id: crumb._id.toString() });
});

module.exports = router;
