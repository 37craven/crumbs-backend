const express = require("express");
const Event = require("../models/Event");
const { Widget } = require("../models/Widget");
const { MAX_ROWS } = require("../models/Event");
const { requireAuth } = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const HttpError = require("../utils/httpError");
const { todayInTimezone } = require("../utils/dates");
const { parseOrThrow } = require("../validators/common");
const { addRowSchema, renameRowSchema } = require("../validators/event");
const { addWidgetSchema, reorderSchema } = require("../validators/widget");
const { addWidget } = require("../services/widgets");
const { refreshEventSummary } = require("../services/eventSummary");
const { serializeWidget, sortWidgets } = require("../services/serializers");
const { eventJson } = require("../services/eventPayload");
const { findAccessibleEvent } = require("../services/access");
const { removeStoredFiles } = require("../services/imageFiles");

// Mounted at /api/events/:id/rows (see routes/events.js). mergeParams lets this
// router see the :id from that path.
const router = express.Router({ mergeParams: true });

router.use(requireAuth);
router.param("id", validateObjectIdParam);
router.param("rowId", validateObjectIdParam);

// Throws a 404 unless the row belongs to the event.
function assertRow(event, rowId) {
  if (!event.rows.some((row) => String(row._id) === String(rowId))) {
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

// POST /api/events/:id/rows — add an empty row at the bottom. Body: { "name"?: "..." }
router.post("/", async (req, res) => {
  const { name } = parseOrThrow(addRowSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);

  // The condition "the row at the last allowed position does not exist yet"
  // makes the row limit atomic: two people adding at once cannot exceed it.
  const updated = await Event.findOneAndUpdate(
    { _id: event._id, [`rows.${MAX_ROWS - 1}`]: { $exists: false } },
    { $push: { rows: { name } } },
    { new: true },
  ).lean();
  if (!updated) throw new HttpError(400, `An event can have at most ${MAX_ROWS} rows`);

  res.status(201).json({ event: await eventJson(updated, req.user._id) });
});

// PATCH /api/events/:id/rows/order — rearrange the rows. Body: { "order": [rowId, ...] }
// Declared BEFORE /:rowId so "order" is not read as a row id.
router.patch("/order", async (req, res) => {
  const { order } = parseOrThrow(reorderSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);

  assertSameIds(order, event.rows.map((row) => String(row._id)), "row");
  const byId = new Map(event.rows.map((row) => [String(row._id), row]));

  const updated = await Event.findByIdAndUpdate(
    event._id,
    { $set: { rows: order.map((id) => byId.get(id)) } },
    { new: true },
  ).lean();

  res.json({ event: await eventJson(updated, req.user._id) });
});

// PATCH /api/events/:id/rows/:rowId — rename a row. Body: { "name": "..." }
router.patch("/:rowId", async (req, res) => {
  const { name } = parseOrThrow(renameRowSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  assertRow(event, req.params.rowId);

  const updated = await Event.findOneAndUpdate(
    { _id: event._id, "rows._id": req.params.rowId },
    { $set: { "rows.$.name": name } }, // "$" = the row that matched above
    { new: true },
  ).lean();
  if (!updated) throw new HttpError(404, "Row not found");

  const saved = await refreshEventSummary(event._id); // row names are searchable
  res.json({ event: await eventJson(saved, req.user._id) });
});

// DELETE /api/events/:id/rows/:rowId — remove a row, its widgets and their pictures.
router.delete("/:rowId", async (req, res) => {
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  assertRow(event, req.params.rowId);

  const widgets = await Widget.find({ event: event._id, row: req.params.rowId }).lean();
  const filenames = widgets.filter((w) => w.image).map((w) => w.image.filename);

  await Widget.deleteMany({ event: event._id, row: req.params.rowId });
  await Event.updateOne({ _id: event._id }, { $pull: { rows: { _id: req.params.rowId } } });
  await removeStoredFiles(filenames);

  const saved = await refreshEventSummary(event._id);
  res.json({
    message: "Row deleted",
    deleted: { widgets: widgets.length, images: filenames.length },
    event: await eventJson(saved, req.user._id),
  });
});

// POST /api/events/:id/rows/:rowId/widgets — add a widget to the end of the row.
// Body: { "type": "notes" | "date" | "image" | "link", ...optional starting content }
router.post("/:rowId/widgets", async (req, res) => {
  const { type, ...data } = parseOrThrow(addWidgetSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);

  const widget = await addWidget(event, req.user._id, req.params.rowId, type, data);
  const saved = await refreshEventSummary(event._id);

  res.status(201).json({
    widget: serializeWidget(widget.toObject(), todayInTimezone()),
    event: await eventJson(saved, req.user._id),
  });
});

// PATCH /api/events/:id/rows/:rowId/widgets/order — rearrange the widgets of one row.
// Body: { "order": [widgetId, ...] }
router.patch("/:rowId/widgets/order", async (req, res) => {
  const { order } = parseOrThrow(reorderSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  assertRow(event, req.params.rowId);

  const current = await Widget.find({ event: event._id, row: req.params.rowId }).select("_id").lean();
  assertSameIds(order, current.map((w) => String(w._id)), "widget");

  await Widget.bulkWrite(
    order.map((id, position) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: position } } },
    })),
  );

  const widgets = await Widget.find({ event: event._id }).lean();
  const today = todayInTimezone();
  res.json({ widgets: sortWidgets(widgets, event).map((w) => serializeWidget(w, today)) });
});

module.exports = router;
