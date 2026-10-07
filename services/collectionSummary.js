const Collection = require("../models/Collection");
const { Widget } = require("../models/Widget");
const { dateSearchText } = require("../utils/dates");

// Widgets in display order: row by row (top to bottom), then left to right.
function inDisplayOrder(collection, widgets) {
  const rowIndex = new Map((collection.rows ?? []).map((row, i) => [String(row._id), i]));
  const position = (widget) => rowIndex.get(String(widget.row)) ?? Number.MAX_SAFE_INTEGER;
  return [...widgets].sort((a, b) => position(a) - position(b) || a.order - b.order);
}

// Builds the collection's summary and its searchable text from the collection and its
// widgets. Pure function: no database access, so it is easy to test.
function buildSummary(collection, widgets) {
  const sorted = inDisplayOrder(collection, widgets);
  const ofType = (type) => sorted.filter((w) => w.type === type);

  const notes = ofType("notes");
  const dates = ofType("date").filter((w) => w.date);
  const images = ofType("image").filter((w) => w.image);
  const links = ofType("link").filter((w) => w.url);

  const collectionDates = dates.map((w) => w.date).sort(); // "YYYY-MM-DD" sorts as text

  // What the Collections card needs: a few notes, pictures and links.
  const noteExcerpts = notes
    .map((w) => (w.body ?? "").trim() || (w.checklist ?? []).map((item) => item.text).join(" · "))
    .filter(Boolean)
    .map((text) => text.slice(0, 140))
    .slice(0, 3);

  const summary = {
    collectionDate: collectionDates[0] ?? null,
    collectionDates,
    noteExcerpts,
    openChecklistItems: notes.reduce(
      (total, w) => total + (w.checklist ?? []).filter((item) => !item.done).length,
      0,
    ),
    imageCount: images.length,
    imageUrls: images.slice(0, 4).map((w) => w.image.url),
    linkCount: links.length,
    links: links.slice(0, 4).map((w) => ({
      url: w.url,
      title: w.preview?.title ?? null,
      image: w.preview?.image ?? null,
      siteName: w.preview?.siteName ?? null,
    })),
  };

  // One lowercase string the search box can match against.
  const searchText = [
    collection.title,
    collection.description,
    ...(collection.tags ?? []),
    ...(collection.rows ?? []).map((row) => row.name),
    ...notes.flatMap((w) => [w.body, ...(w.checklist ?? []).map((item) => item.text)]),
    ...dates.flatMap((w) => [dateSearchText(w.date), w.label]),
    ...links.flatMap((w) => [w.url, w.preview?.title, w.preview?.siteName]),
    ...images.map((w) => w.image.originalName),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .slice(0, 20000);

  return { summary, searchText };
}

// Recomputes and saves a collection's summary. Call it after ANY change to the
// collection's title/description/tags/rows or to any of its widgets.
// Returns the updated collection (plain object), or null if the collection is gone.
async function refreshCollectionSummary(collectionId) {
  const [collection, widgets] = await Promise.all([
    Collection.findById(collectionId).lean(),
    Widget.find({ collectionId: collectionId }).lean(),
  ]);
  if (!collection) return null;

  const { summary, searchText } = buildSummary(collection, widgets);

  // A blank "new" collection becomes a draft the moment anything is added to it.
  const hasContent = Boolean(
    collection.title?.trim() || collection.description?.trim() || (collection.tags ?? []).length || widgets.length,
  );
  const status = collection.status === "new" && hasContent ? "draft" : collection.status;

  // This write also bumps `updatedAt`, so editing a widget moves the collection to
  // the top of "recently edited" for everyone it is shared with.
  return Collection.findByIdAndUpdate(
    collectionId,
    { $set: { summary, searchText, status } },
    { new: true },
  ).lean();
}

module.exports = { buildSummary, refreshCollectionSummary, inDisplayOrder };
