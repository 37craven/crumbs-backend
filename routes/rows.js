const express = require("express");
const Collection = require("../models/Collection");
const { Widget } = require("../models/Widget");
const { MAX_ROWS } = require("../models/Collection");
const { requireAuth } = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const HttpError = require("../utils/httpError");
const { todayInTimezone } = require("../utils/dates");
const { parseOrThrow } = require("../validators/common");
const { addRowSchema, renameRowSchema } = require("../validators/collection");
const { addWidgetSchema, reorderSchema } = require("../validators/widget");
const { addWidget } = require("../services/widgets");
const { refreshCollectionSummary } = require("../services/collectionSummary");
const { serializeWidget, sortWidgets } = require("../services/serializers");
const { collectionJson } = require("../services/collectionPayload");
const { findAccessibleCollection } = require("../services/access");
const { removeStoredFiles } = require("../services/imageFiles");

// Mounted at /api/collections/:id/rows (see routes/collections.js). mergeParams lets this
// router see the :id from that path.
const router = express.Router({ mergeParams: true });

router.use(requireAuth);
router.param("id", validateObjectIdParam);
router.param("rowId", validateObjectIdParam);

// Throws a 404 unless the row belongs to the collection.
function assertRow(collection, rowId) {
  if (!collection.rows.some((row) => String(row._id) === String(rowId))) {
    throw new HttpError(404, "Row not found");
  }
}

// Checks that `order` lists exactly the ids in `currentIds`, once each.
function assertSameIds(order, currentIds, what) {
  const sent = new Set(order);
  const same =
    order.length === currentIds.length &&
    sent.size === order.length &&
    currentIds.every((id) => sent.has(id));
  if (!same) throw new HttpError(400, `Send every ${what} id exactly once`);
}

// POST /api/collections/:id/rows — add an empty row at the bottom. Body: { "name"?: "..." }
router.post("/", async (req, res) => {
  const { name } = parseOrThrow(addRowSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);

  // The condition "the row at the last allowed position does not exist yet"
  // makes the row limit atomic: two people adding at once cannot exceed it.
  const updated = await Collection.findOneAndUpdate(
    { _id: collection._id, [`rows.${MAX_ROWS - 1}`]: { $exists: false } },
    { $push: { rows: { name } } },
    { new: true },
  ).lean();
  if (!updated) throw new HttpError(400, `A collection can have at most ${MAX_ROWS} rows`);

  res.status(201).json({ collection: await collectionJson(updated, req.user._id) });
});

// PATCH /api/collections/:id/rows/order — rearrange the rows. Body: { "order": [rowId, ...] }
// Declared BEFORE /:rowId so "order" is not read as a row id.
router.patch("/order", async (req, res) => {
  const { order } = parseOrThrow(reorderSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);

  assertSameIds(order, collection.rows.map((row) => String(row._id)), "row");
  const byId = new Map(collection.rows.map((row) => [String(row._id), row]));

  const updated = await Collection.findByIdAndUpdate(
    collection._id,
    { $set: { rows: order.map((id) => byId.get(id)) } },
    { new: true },
  ).lean();

  res.json({ collection: await collectionJson(updated, req.user._id) });
});

// PATCH /api/collections/:id/rows/:rowId — rename a row. Body: { "name": "..." }
router.patch("/:rowId", async (req, res) => {
  const { name } = parseOrThrow(renameRowSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  assertRow(collection, req.params.rowId);

  const updated = await Collection.findOneAndUpdate(
    { _id: collection._id, "rows._id": req.params.rowId },
    { $set: { "rows.$.name": name } }, // "$" = the row that matched above
    { new: true },
  ).lean();
  if (!updated) throw new HttpError(404, "Row not found");

  const saved = await refreshCollectionSummary(collection._id); // row names are searchable
  res.json({ collection: await collectionJson(saved, req.user._id) });
});

// DELETE /api/collections/:id/rows/:rowId — remove a row, its widgets and their pictures.
router.delete("/:rowId", async (req, res) => {
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  assertRow(collection, req.params.rowId);

  const widgets = await Widget.find({ collectionId: collection._id, row: req.params.rowId }).lean();
  const filenames = widgets.filter((w) => w.image).map((w) => w.image.filename);

  await Widget.deleteMany({ collectionId: collection._id, row: req.params.rowId });
  await Collection.updateOne({ _id: collection._id }, { $pull: { rows: { _id: req.params.rowId } } });
  await removeStoredFiles(filenames);

  const saved = await refreshCollectionSummary(collection._id);
  res.json({
    message: "Row deleted",
    deleted: { widgets: widgets.length, images: filenames.length },
    collection: await collectionJson(saved, req.user._id),
  });
});

// POST /api/collections/:id/rows/:rowId/widgets — add a widget to the end of the row.
// Body: { "type": "notes" | "date" | "image" | "link", ...optional starting content }
router.post("/:rowId/widgets", async (req, res) => {
  const { type, ...data } = parseOrThrow(addWidgetSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);

  const widget = await addWidget(collection, req.user._id, req.params.rowId, type, data);
  const saved = await refreshCollectionSummary(collection._id);

  res.status(201).json({
    widget: serializeWidget(widget.toObject(), todayInTimezone()),
    collection: await collectionJson(saved, req.user._id),
  });
});

// PATCH /api/collections/:id/rows/:rowId/widgets/order — rearrange the widgets of one row.
// Body: { "order": [widgetId, ...] }
router.patch("/:rowId/widgets/order", async (req, res) => {
  const { order } = parseOrThrow(reorderSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  assertRow(collection, req.params.rowId);

  const current = await Widget.find({ collectionId: collection._id, row: req.params.rowId }).select("_id").lean();
  assertSameIds(order, current.map((w) => String(w._id)), "widget");

  await Widget.bulkWrite(
    order.map((id, position) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: position } } },
    })),
  );

  const widgets = await Widget.find({ collectionId: collection._id }).lean();
  const today = todayInTimezone();
  res.json({ widgets: sortWidgets(widgets, collection).map((w) => serializeWidget(w, today)) });
});

module.exports = router;
