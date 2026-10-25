const express = require("express");
const Collection = require("../models/Collection");
const { Widget } = require("../models/Widget");
const { imageFromUpload } = require("../models/Image");
const { requireAuth } = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const { uploadImage } = require("../middleware/upload");
const HttpError = require("../utils/httpError");
const { todayInTimezone } = require("../utils/dates");
const { parseOrThrow } = require("../validators/common");
const { widgetUpdateSchemas, checklistToggleSchema } = require("../validators/widget");
const { applyWidgetData } = require("../services/widgets");
const { refreshCollectionSummary } = require("../services/collectionSummary");
const { serializeWidget } = require("../services/serializers");
const { collectionJson } = require("../services/collectionPayload");
const { accessFilter } = require("../services/access");
const { sendImage } = require("../services/images");

const router = express.Router();

router.use(requireAuth);
router.param("id", validateObjectIdParam);
router.param("itemId", validateObjectIdParam);

// Returns a Mongoose document (not a plain object) because callers change and
// save it. A widget belongs to a collection, so whoever may edit the collection may edit
// its widgets. Everyone else gets a 404, same as for a missing widget.
async function findEditableWidget(id, userId) {
  const widget = await Widget.findById(id);
  if (!widget) throw new HttpError(404, "Widget not found");

  const allowed = await Collection.exists({ _id: widget.collectionId, ...accessFilter(userId) });
  if (!allowed) throw new HttpError(404, "Widget not found");

  return widget;
}

// Reading a picture needs the same access check as editing, but does not need the
// document back as something editable — only the bytes and what says which they
// are.
async function sendWidgetImage(req, res) {
  // `+image.data` because the bytes are select:false on every ordinary query.
  const widget = await Widget.findById(req.params.id).select("collectionId type image +image.data");

  const allowed =
    widget &&
    widget.type === "image" &&
    (await Collection.exists({ _id: widget.collectionId, ...accessFilter(req.user._id) }));
  if (!allowed) throw new HttpError(404, "Widget not found");

  return sendImage(req, res, widget.image);
}

// Every successful change responds with the updated widget AND the updated
// collection summary, so the page can refresh the widget and the grid card at once.
async function respond(res, widget, userId, status = 200) {
  const collection = await refreshCollectionSummary(widget.collectionId);
  // The collection can be deleted (e.g. in another tab) while a widget is being saved.
  if (!collection) throw new HttpError(404, "Collection not found");

  res.status(status).json({
    widget: serializeWidget(widget.toObject(), todayInTimezone()),
    collection: await collectionJson(collection, userId),
  });
}

// GET /api/widgets/:id
router.get("/:id", async (req, res) => {
  const widget = await findEditableWidget(req.params.id, req.user._id);
  res.json({ widget: serializeWidget(widget.toObject()) });
});

// GET /api/widgets/:id/image — the picture inside an image widget. Follows the same
// access rule as the widget itself: whoever may edit that collection may see it.
router.get("/:id/image", sendWidgetImage);

// PATCH /api/widgets/:id — change a notes, date or link widget.
// What the body may contain depends on the widget's type:
//   notes: { body?, checklist? }   date: { date?, label? }   link: { url? }
router.patch("/:id", async (req, res) => {
  const widget = await findEditableWidget(req.params.id, req.user._id);

  const schema = widgetUpdateSchemas[widget.type];
  if (!schema) {
    throw new HttpError(400, "The picture of an image widget changes through the /image endpoint");
  }

  await applyWidgetData(widget, parseOrThrow(schema, req.body));
  await widget.save();
  await respond(res, widget, req.user._id);
});

// DELETE /api/widgets/:id — remove a widget, and with it the picture it held.
router.delete("/:id", async (req, res) => {
  const widget = await findEditableWidget(req.params.id, req.user._id);
  const images = widget.image ? 1 : 0;

  await Widget.deleteOne({ _id: widget._id });

  const collection = await refreshCollectionSummary(widget.collectionId);
  res.json({
    message: "Widget deleted",
    // How many pictures went with it. Nothing is deleted separately — the bytes
    // were inside the widget — but the count is what the collections and rows
    // routes report too.
    deleted: { images },
    collection: collection ? await collectionJson(collection, req.user._id) : null,
  });
});

// PATCH /api/widgets/:id/checklist/:itemId — tick or untick one checklist item.
// Body: { "done": true }. With no body the item is toggled.
router.patch("/:id/checklist/:itemId", async (req, res) => {
  const { done } = parseOrThrow(checklistToggleSchema, req.body);
  const widget = await findEditableWidget(req.params.id, req.user._id);

  if (widget.type !== "notes") {
    throw new HttpError(400, "Only the notes widget has a checklist");
  }
  const item = widget.checklist.id(req.params.itemId);
  if (!item) throw new HttpError(404, "Checklist item not found");

  item.done = done ?? !item.done;
  await widget.save();
  await respond(res, widget, req.user._id);
});

// POST /api/widgets/:id/image — put a picture in an image widget (multipart/form-data,
// field name "image"). An image widget holds ONE picture: uploading again replaces it.
// Nothing is written to disk, so a failure before it is saved simply drops the buffer.
router.post("/:id/image", uploadImage, async (req, res) => {
  const file = req.file;

  const widget = await findEditableWidget(req.params.id, req.user._id);

  if (widget.type !== "image") {
    throw new HttpError(400, "Pictures can only be added to an image widget");
  }
  if (!file) {
    throw new HttpError(
      400,
      'No image received. Send it as multipart/form-data in the field "image".',
    );
  }

  // Assigning a new subdocument replaces the old one whole, so the picture it
  // held is released with it.
  widget.image = imageFromUpload(file);
  await widget.save();

  await respond(res, widget, req.user._id, 201);
});

// DELETE /api/widgets/:id/image — empty the widget (the widget itself stays).
router.delete("/:id/image", async (req, res) => {
  const widget = await findEditableWidget(req.params.id, req.user._id);

  if (widget.type !== "image") {
    throw new HttpError(400, "Only image widgets have a picture");
  }
  if (!widget.image) throw new HttpError(404, "This widget has no picture");

  widget.image = null;
  await widget.save();
  await respond(res, widget, req.user._id);
});

module.exports = router;
