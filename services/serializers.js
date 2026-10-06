const { daysBetween, todayInTimezone } = require("../utils/dates");
const { inDisplayOrder } = require("./collectionSummary");
const { buildTiles } = require("./collectionTiles");
const { ALLOWED_TRANSITIONS } = require("./collectionStatus");

// Turns database objects into the JSON the frontend receives.
// Two reasons not to send documents as they are:
//   1. Internal fields (searchText, file names on disk...) stay private.
//   2. Date-dependent values are worked out HERE, at read time. "3 days left"
//      is wrong tomorrow, so it is never stored.

function dateInfo(dateString, today) {
  if (!dateString) return { dateStatus: null, daysUntil: null };
  const daysUntil = daysBetween(today, dateString);
  const dateStatus = daysUntil < 0 ? "past" : daysUntil === 0 ? "today" : "upcoming";
  return { dateStatus, daysUntil };
}

// `ctx` comes from collectionContext(): { today, viewerId, people }.
// All three are optional so the function can be tested on its own.
function serializeCollection(collection, ctx = {}) {
  const today = ctx.today ?? todayInTimezone();
  const person = (id) =>
    ctx.people?.get(String(id)) ?? { id: String(id), username: null };

  const s = collection.summary ?? {};
  const { dateStatus, daysUntil } = dateInfo(s.collectionDate, today);

  return {
    id: String(collection._id),
    title: collection.title,
    description: collection.description ?? "",
    tags: collection.tags ?? [],
    status: collection.status,
    owner: person(collection.owner),
    collaborators: (collection.collaborators ?? []).map(person),
    rows: (collection.rows ?? []).map((row) => ({ id: String(row._id), name: row.name ?? "" })),
    // "owner" can delete and manage people; "collaborator" can edit the content.
    role: ctx.viewerId
      ? String(collection.owner) === ctx.viewerId
        ? "owner"
        : "collaborator"
      : null,
    // The statuses this collection can be moved to right now (for a dropdown).
    nextStatuses: ALLOWED_TRANSITIONS[collection.status] ?? [],
    // A planned collection whose date has passed needs attention.
    isOverdue: collection.status === "planned" && dateStatus === "past",
    summary: {
      collectionDate: s.collectionDate ?? null,
      collectionDates: s.collectionDates ?? [],
      dateStatus,
      daysUntil,
      imageCount: s.imageCount ?? 0, // shown as "N memories"
      linkCount: s.linkCount ?? 0,
      // The four tiles of the Collections card (date, note, image, link).
      // Date tiles also say how far away they are ("Today", "in 3 days").
      tiles: buildTiles(s).map((tile) =>
        tile.type === "date" ? { ...tile, ...dateInfo(tile.date, today) } : tile,
      ),
    },
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
  };
}

// Row by row (in the order of collection.rows), then left to right inside each row.
function sortWidgets(widgets, collection = {}) {
  return inDisplayOrder(collection, widgets);
}

function serializeWidget(widget, today = todayInTimezone()) {
  const base = {
    id: String(widget._id),
    collectionId: String(widget.collectionId),
    rowId: widget.row ? String(widget.row) : null,
    type: widget.type,
    order: widget.order,
    createdBy: widget.createdBy ? String(widget.createdBy) : null,
    createdAt: widget.createdAt,
    updatedAt: widget.updatedAt,
  };

  switch (widget.type) {
    case "notes":
      return {
        ...base,
        body: widget.body ?? "",
        checklist: (widget.checklist ?? []).map((item) => ({
          id: String(item._id),
          text: item.text,
          done: item.done,
        })),
      };

    case "image":
      return {
        ...base,
        image: widget.image
          ? {
              url: widget.image.url,
              originalName: widget.image.originalName,
              mimeType: widget.image.mimeType,
              size: widget.image.size,
            }
          : null,
      };

    case "date":
      return {
        ...base,
        date: widget.date ?? null,
        label: widget.label ?? "",
        ...dateInfo(widget.date, today),
      };

    case "link":
      return {
        ...base,
        url: widget.url ?? null,
        embedUrl: widget.embedUrl ?? null,
        preview: widget.preview ?? null,
      };

    default:
      return base;
  }
}

module.exports = { serializeCollection, serializeWidget, sortWidgets, dateInfo };
