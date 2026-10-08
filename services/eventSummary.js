const Event = require("../models/Event");
const { Widget } = require("../models/Widget");
const { dateSearchText } = require("../utils/dates");

// Widgets in display order: row by row (top to bottom), then left to right.
function inDisplayOrder(event, widgets) {
  const rowIndex = new Map((event.rows ?? []).map((row, i) => [String(row._id), i]));
  const position = (widget) => rowIndex.get(String(widget.row)) ?? Number.MAX_SAFE_INTEGER;
  return [...widgets].sort((a, b) => position(a) - position(b) || a.order - b.order);
}

// Builds the event's summary and its searchable text from the event and its
// widgets. Pure function: no database access, so it is easy to test.
function buildSummary(event, widgets) {
  const sorted = inDisplayOrder(event, widgets);
  const ofType = (type) => sorted.filter((w) => w.type === type);

  const notes = ofType("notes");
  const dates = ofType("date").filter((w) => w.date);
  const images = ofType("image").filter((w) => w.image);
  const links = ofType("link").filter((w) => w.url);

  const eventDates = dates.map((w) => w.date).sort(); // "YYYY-MM-DD" sorts as text

  // What the Collections card needs: a few notes, pictures and links.
  const noteExcerpts = notes
    .map((w) => (w.body ?? "").trim() || (w.checklist ?? []).map((item) => item.text).join(" · "))
    .filter(Boolean)
    .map((text) => text.slice(0, 140))
    .slice(0, 3);

  const summary = {
    eventDate: eventDates[0] ?? null,
    eventDates,
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
    event.title,
    event.description,
    ...(event.tags ?? []),
    ...(event.rows ?? []).map((row) => row.name),
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

// Recomputes and saves an event's summary. Call it after ANY change to the
// event's title/description/tags/rows or to any of its widgets.
// Returns the updated event (plain object), or null if the event is gone.
async function refreshEventSummary(eventId) {
  const [event, widgets] = await Promise.all([
    Event.findById(eventId).lean(),
    Widget.find({ event: eventId }).lean(),
  ]);
  if (!event) return null;

  const { summary, searchText } = buildSummary(event, widgets);

  // A blank "new" event becomes a draft the moment anything is added to it.
  const hasContent = Boolean(
    event.title?.trim() || event.description?.trim() || (event.tags ?? []).length || widgets.length,
  );
  const status = event.status === "new" && hasContent ? "draft" : event.status;

  // This write also bumps `updatedAt`, so editing a widget moves the event to
  // the top of "recently edited" for everyone it is shared with.
  return Event.findByIdAndUpdate(
    eventId,
    { $set: { summary, searchText, status } },
    { new: true },
  ).lean();
}

module.exports = { buildSummary, refreshEventSummary, inDisplayOrder };
