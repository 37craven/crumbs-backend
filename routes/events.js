const express = require("express");
const Event = require("../models/Event");
const { Widget } = require("../models/Widget");
const { MAX_COLLABORATORS } = require("../models/Event");
const { requireAuth } = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const HttpError = require("../utils/httpError");
const { todayInTimezone, addDays } = require("../utils/dates");
const { parseOrThrow } = require("../validators/common");
const {
  createEventSchema,
  updateEventSchema,
  statusSchema,
  addCollaboratorSchema,
} = require("../validators/event");
const {
  searchQuerySchema,
  listQuerySchema,
  upcomingQuerySchema,
} = require("../validators/search");
const { refreshEventSummary } = require("../services/eventSummary");v
const { serializeWidget, sortWidgets } = require("../services/serializers");
const { eventPayload, eventJson, eventList } = require("../services/eventPayload");
const { checkTransition } = require("../services/eventStatus");
const { findEvents } = require("../services/eventSearch");
const { accessFilter, findAccessibleEvent, assertOwner } = require("../services/access");
const { assertCanInvite } = require("../services/friends");
const { removeStoredFiles } = require("../services/imageFiles");
const rowRoutes = require("./rows");

const router = express.Router();

router.use(requireAuth); // every events route needs a logged-in user
router.param("id", validateObjectIdParam); // reject malformed ids with a 400
router.param("userId", validateObjectIdParam);

const loadWidgets = (eventId) => Widget.find({ event: eventId }).lean();

function pagination(total, { page, limit }) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

// IMPORTANT: /search and /upcoming are declared BEFORE /:id.
// Express checks routes top to bottom, so otherwise "search" would be read as
// an event id.

// GET /api/events — the Collections grid: events I created plus events shared
// with me, recently edited first.
router.get("/", async (req, res) => {
  const { page, limit } = parseOrThrow(listQuerySchema, req.query);
  const query = { q: "", scope: "all", status: [], tags: [], has: [], sort: "recent", page, limit };

  // Housekeeping: blank events nobody filled in within an hour are removed.
  await Event.deleteMany({
    owner: req.user._id,
    status: "new",
    createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) },
  });

  const { events, total } = await findEvents(req.user._id, query);

  res.json({
    events: await eventList(events, req.user._id),
    pagination: pagination(total, query),
  });
});

// GET /api/events/search?q=&scope=&status=&tags=&has=&dateFrom=&dateTo=&sort=&page=&limit=
router.get("/search", async (req, res) => {
  const query = parseOrThrow(searchQuerySchema, req.query);

  const { events, total } = await findEvents(req.user._id, query);

  res.json({
    events: await eventList(events, req.user._id),
    pagination: pagination(total, query),
  });
});

// GET /api/events/upcoming?days=30&limit=10 — open events happening soon.
router.get("/upcoming", async (req, res) => {
  const { days, limit } = parseOrThrow(upcomingQuerySchema, req.query);
  const today = todayInTimezone();
  const until = addDays(today, days);

  const events = await Event.find({
    ...accessFilter(req.user._id),
    status: { $in: ["draft", "planned"] }, // done and archived are not "upcoming"
    "summary.eventDate": { $gte: today, $lte: until },
  })
    .sort({ "summary.eventDate": 1, _id: 1 })
    .limit(limit)
    .lean();

  res.json({ from: today, to: until, events: await eventList(events, req.user._id) });
});

// POST /api/events — open a new event: ONE empty row, no widgets. With no title
// (or anything else) it is "new"; the frontend deletes it again if the user leaves
// without adding anything, and it turns into a draft once something is added.
router.post("/", async (req, res) => {
  const input = parseOrThrow(createEventSchema, req.body);
  const collaborators = await assertCanInvite(req.user._id, input.collaborators);

  const event = await Event.create({
    owner: req.user._id,
    title: input.title,
    description: input.description,
    tags: input.tags,
    collaborators,
    status: input.title || input.description || input.tags.length ? "draft" : "new",
    rows: [{ name: "" }], // every event starts with one empty row
  });

  const saved = await refreshEventSummary(event._id);
  res.status(201).json(await eventPayload(saved, await loadWidgets(event._id), req.user._id));
});

// GET /api/events/:id — one event with its widgets.
router.get("/:id", async (req, res) => {
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  res.json(await eventPayload(event, await loadWidgets(event._id), req.user._id));
});

// PATCH /api/events/:id — change title, description or tags.
router.patch("/:id", async (req, res) => {
  const changes = parseOrThrow(updateEventSchema, req.body);

  const updated = await Event.findOneAndUpdate(
    { _id: req.params.id, ...accessFilter(req.user._id) },
    { $set: changes },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw new HttpError(404, "Event not found");

  // The title and tags are part of the searchable text, so refresh it.
  const event = await refreshEventSummary(updated._id);
  if (!event) throw new HttpError(404, "Event not found");

  res.json({ event: await eventJson(event, req.user._id) });
});

// PATCH /api/events/:id/status — move an event through draft/planned/done/archived.
router.patch("/:id/status", async (req, res) => {
  const { status } = parseOrThrow(statusSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);

  const problem = checkTransition(event, status);
  if (problem) throw new HttpError(409, problem);

  // Matching on the old status makes the update fail if someone changed it
  // between our read and our write, instead of silently overwriting.
  const updated = await Event.findOneAndUpdate(
    { _id: event._id, status: event.status },
    { $set: { status } },
    { new: true },
  ).lean();
  if (!updated) {
    throw new HttpError(409, "This event was just changed. Reload and try again.");
  }

  res.json({ event: await eventJson(updated, req.user._id) });
});

// DELETE /api/events/:id — creator only. Removes the event, its widgets and
// its image files, for everyone it was shared with.
router.delete("/:id", async (req, res) => {
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  assertOwner(event, req.user._id, "delete this event");

  const widgets = await loadWidgets(event._id);
  const filenames = widgets.filter((w) => w.image).map((w) => w.image.filename);

  await Widget.deleteMany({ event: event._id });
  await Event.deleteOne({ _id: event._id });
  await removeStoredFiles(filenames);

  res.json({
    message: "Event deleted",
    deleted: { widgets: widgets.length, images: filenames.length },
  });
});

// ---- Sharing -----------------------------------------------------------------

// POST /api/events/:id/collaborators — creator only. Body: { "userId": "..." }
// The person must be on the creator's friends list.
router.post("/:id/collaborators", async (req, res) => {
  const { userId } = parseOrThrow(addCollaboratorSchema, req.body);
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  assertOwner(event, req.user._id, "add people to this event");

  if (event.collaborators.some((id) => String(id) === userId)) {
    throw new HttpError(409, "That person is already part of this event");
  }
  if (event.collaborators.length >= MAX_COLLABORATORS) {
    throw new HttpError(400, `An event can be shared with at most ${MAX_COLLABORATORS} people`);
  }
  await assertCanInvite(req.user._id, [userId]); // 400 unless they are a friend

  const updated = await Event.findByIdAndUpdate(
    event._id,
    { $addToSet: { collaborators: userId } },
    { new: true },
  ).lean();

  res.status(201).json({ event: await eventJson(updated, req.user._id) });
});

// DELETE /api/events/:id/collaborators/:userId — the creator can remove anyone;
// a collaborator can only remove themselves (leave the event).
router.delete("/:id/collaborators/:userId", async (req, res) => {
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  const target = req.params.userId;
  const leaving = target === String(req.user._id);

  if (target === String(event.owner)) {
    throw new HttpError(400, "The creator cannot be removed from their own event");
  }
  if (!event.collaborators.some((id) => String(id) === target)) {
    throw new HttpError(404, "That person is not part of this event");
  }
  if (!leaving) assertOwner(event, req.user._id, "remove other people");

  await Event.updateOne({ _id: event._id }, { $pull: { collaborators: target } });
  res.json({ message: leaving ? "You left the event" : "Person removed from the event" });
});

// ---- Widgets of one event ---------------------------------------------------------

// GET /api/events/:id/widgets — just the widgets, in layout order.
router.get("/:id/widgets", async (req, res) => {
  const event = await findAccessibleEvent(req.params.id, req.user._id);
  const widgets = await loadWidgets(event._id);
  const today = todayInTimezone();

  res.json({ widgets: sortWidgets(widgets, event).map((widget) => serializeWidget(widget, today)) });
});

// Rows and the widgets inside them: /api/events/:id/rows/... (see routes/rows.js)
router.use("/:id/rows", rowRoutes);

module.exports = router;
