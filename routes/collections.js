const express = require("express");
const Collection = require("../models/Collection");
const { Widget } = require("../models/Widget");
const { MAX_COLLABORATORS } = require("../models/Collection");
const { requireAuth } = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const HttpError = require("../utils/httpError");
const { todayInTimezone, addDays } = require("../utils/dates");
const { parseOrThrow } = require("../validators/common");
const {
  createCollectionSchema,
  updateCollectionSchema,
  statusSchema,
  addCollaboratorSchema,
} = require("../validators/collection");
const {
  searchQuerySchema,
  listQuerySchema,
  upcomingQuerySchema,
} = require("../validators/search");
const { refreshCollectionSummary } = require("../services/collectionSummary");
const { serializeWidget, sortWidgets } = require("../services/serializers");
const { collectionPayload, collectionJson, collectionList } = require("../services/collectionPayload");
const { checkTransition } = require("../services/collectionStatus");
const { findCollections } = require("../services/collectionSearch");
const { accessFilter, findAccessibleCollection, assertOwner } = require("../services/access");
const { assertCanInvite } = require("../services/friends");
const { removeStoredFiles } = require("../services/imageFiles");
const rowRoutes = require("./rows");

const router = express.Router();

router.use(requireAuth); // every collections route needs a logged-in user
router.param("id", validateObjectIdParam); // reject malformed ids with a 400
router.param("userId", validateObjectIdParam);

const loadWidgets = (collectionId) => Widget.find({ collectionId: collectionId }).lean();

function pagination(total, { page, limit }) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

// IMPORTANT: /search and /upcoming are declared BEFORE /:id.
// Express checks routes top to bottom, so otherwise "search" would be read as
// a collection id.

// GET /api/collections — the Collections grid: collections I created plus collections shared
// with me, recently edited first.
router.get("/", async (req, res) => {
  const { page, limit } = parseOrThrow(listQuerySchema, req.query);
  const query = { q: "", scope: "all", status: [], tags: [], has: [], sort: "recent", page, limit };

  // Housekeeping: blank collections nobody filled in within an hour are removed.
  await Collection.deleteMany({
    owner: req.user._id,
    status: "new",
    createdAt: { $lt: new Date(Date.now() - 60 * 60 * 1000) },
  });

  const { collections, total } = await findCollections(req.user._id, query);

  res.json({
    collections: await collectionList(collections, req.user._id),
    pagination: pagination(total, query),
  });
});

// GET /api/collections/search?q=&scope=&status=&tags=&has=&dateFrom=&dateTo=&sort=&page=&limit=
router.get("/search", async (req, res) => {
  const query = parseOrThrow(searchQuerySchema, req.query);

  const { collections, total } = await findCollections(req.user._id, query);

  res.json({
    collections: await collectionList(collections, req.user._id),
    pagination: pagination(total, query),
  });
});

// GET /api/collections/upcoming?days=30&limit=10 — open collections happening soon.
router.get("/upcoming", async (req, res) => {
  const { days, limit } = parseOrThrow(upcomingQuerySchema, req.query);
  const today = todayInTimezone();
  const until = addDays(today, days);

  const collections = await Collection.find({
    ...accessFilter(req.user._id),
    status: { $in: ["draft", "planned"] }, // done and archived are not "upcoming"
    "summary.collectionDate": { $gte: today, $lte: until },
  })
    .sort({ "summary.collectionDate": 1, _id: 1 })
    .limit(limit)
    .lean();

  res.json({ from: today, to: until, collections: await collectionList(collections, req.user._id) });
});

// POST /api/collections — open a new collection: ONE empty row, no widgets. With no title
// (or anything else) it is "new"; the frontend deletes it again if the user leaves
// without adding anything, and it turns into a draft once something is added.
router.post("/", async (req, res) => {
  const input = parseOrThrow(createCollectionSchema, req.body);
  const collaborators = await assertCanInvite(req.user._id, input.collaborators);

  const collection = await Collection.create({
    owner: req.user._id,
    title: input.title,
    description: input.description,
    tags: input.tags,
    collaborators,
    status: input.title || input.description || input.tags.length ? "draft" : "new",
    rows: [{ name: "" }], // every collection starts with one empty row
  });

  const saved = await refreshCollectionSummary(collection._id);
  res.status(201).json(await collectionPayload(saved, await loadWidgets(collection._id), req.user._id));
});

// GET /api/collections/:id — one collection with its widgets.
router.get("/:id", async (req, res) => {
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  res.json(await collectionPayload(collection, await loadWidgets(collection._id), req.user._id));
});

// PATCH /api/collections/:id — change title, description or tags.
router.patch("/:id", async (req, res) => {
  const changes = parseOrThrow(updateCollectionSchema, req.body);

  const updated = await Collection.findOneAndUpdate(
    { _id: req.params.id, ...accessFilter(req.user._id) },
    { $set: changes },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw new HttpError(404, "Collection not found");

  // The title and tags are part of the searchable text, so refresh it.
  const collection = await refreshCollectionSummary(updated._id);
  if (!collection) throw new HttpError(404, "Collection not found");

  res.json({ collection: await collectionJson(collection, req.user._id) });
});

// PATCH /api/collections/:id/status — move a collection through draft/planned/done/archived.
router.patch("/:id/status", async (req, res) => {
  const { status } = parseOrThrow(statusSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);

  const problem = checkTransition(collection, status);
  if (problem) throw new HttpError(409, problem);

  // Matching on the old status makes the update fail if someone changed it
  // between our read and our write, instead of silently overwriting.
  const updated = await Collection.findOneAndUpdate(
    { _id: collection._id, status: collection.status },
    { $set: { status } },
    { new: true },
  ).lean();
  if (!updated) {
    throw new HttpError(409, "This collection was just changed. Reload and try again.");
  }

  res.json({ collection: await collectionJson(updated, req.user._id) });
});

// DELETE /api/collections/:id — creator only. Removes the collection, its widgets and
// its image files, for everyone it was shared with.
router.delete("/:id", async (req, res) => {
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  assertOwner(collection, req.user._id, "delete this collection");

  const widgets = await loadWidgets(collection._id);
  const filenames = widgets.filter((w) => w.image).map((w) => w.image.filename);

  await Widget.deleteMany({ collectionId: collection._id });
  await Collection.deleteOne({ _id: collection._id });
  await removeStoredFiles(filenames);

  res.json({
    message: "Collection deleted",
    deleted: { widgets: widgets.length, images: filenames.length },
  });
});

// ---- Sharing -----------------------------------------------------------------

// POST /api/collections/:id/collaborators — creator only. Body: { "userId": "..." }
// The person must be on the creator's friends list.
router.post("/:id/collaborators", async (req, res) => {
  const { userId } = parseOrThrow(addCollaboratorSchema, req.body);
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  assertOwner(collection, req.user._id, "add people to this collection");

  if (collection.collaborators.some((id) => String(id) === userId)) {
    throw new HttpError(409, "That person is already part of this collection");
  }
  if (collection.collaborators.length >= MAX_COLLABORATORS) {
    throw new HttpError(400, `A collection can be shared with at most ${MAX_COLLABORATORS} people`);
  }
  await assertCanInvite(req.user._id, [userId]); // 400 unless they are a friend

  const updated = await Collection.findByIdAndUpdate(
    collection._id,
    { $addToSet: { collaborators: userId } },
    { new: true },
  ).lean();

  res.status(201).json({ collection: await collectionJson(updated, req.user._id) });
});

// DELETE /api/collections/:id/collaborators/:userId — the creator can remove anyone;
// a collaborator can only remove themselves (leave the collection).
router.delete("/:id/collaborators/:userId", async (req, res) => {
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  const target = req.params.userId;
  const leaving = target === String(req.user._id);

  if (target === String(collection.owner)) {
    throw new HttpError(400, "The creator cannot be removed from their own collection");
  }
  if (!collection.collaborators.some((id) => String(id) === target)) {
    throw new HttpError(404, "That person is not part of this collection");
  }
  if (!leaving) assertOwner(collection, req.user._id, "remove other people");

  await Collection.updateOne({ _id: collection._id }, { $pull: { collaborators: target } });
  res.json({ message: leaving ? "You left the collection" : "Person removed from the collection" });
});

// ---- Widgets of one collection ---------------------------------------------------------

// GET /api/collections/:id/widgets — just the widgets, in layout order.
router.get("/:id/widgets", async (req, res) => {
  const collection = await findAccessibleCollection(req.params.id, req.user._id);
  const widgets = await loadWidgets(collection._id);
  const today = todayInTimezone();

  res.json({ widgets: sortWidgets(widgets, collection).map((widget) => serializeWidget(widget, today)) });
});

// Rows and the widgets inside them: /api/collections/:id/rows/... (see routes/rows.js)
router.use("/:id/rows", rowRoutes);

module.exports = router;
