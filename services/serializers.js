const { daysBetween, todayInTimezone } = require("../utils/dates");
const { inDisplayOrder } = require("./eventSummary");
const { buildTiles } = require("./eventTiles");
const { ALLOWED_TRANSITIONS } = require("./eventStatus");

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

// `ctx` comes from eventContext(): { today, viewerId, people }.
// All three are optional so the function can be tested on its own.
function serializeEvent(event, ctx = {}) {
  const today = ctx.today ?? todayInTimezone();
  const person = (id) =>
    ctx.people?.get(String(id)) ?? { id: String(id), username: null };

  const s = event.summary ?? {};
  const { dateStatus, daysUntil } = dateInfo(s.eventDate, today);

  return {
    id: String(event._id),
    title: event.title,
    description: event.description ?? "",
    tags: event.tags ?? [],
    status: event.status,
    owner: person(event.owner),
    collaborators: (event.collaborators ?? []).map(person),
    rows: (event.rows ?? []).map((row) => ({ id: String(row._id), name: row.name ?? "" })),
    // "owner" can delete and manage people; "collaborator" can edit the content.
    role: ctx.viewerId
      ? String(event.owner) === ctx.viewerId
        ? "owner"
        : "collaborator"
      : null,
    // The statuses this event can be moved to right now (for a dropdown).
    nextStatuses: ALLOWED_TRANSITIONS[event.status] ?? [],
    // A planned event whose date has passed needs attention.
    isOverdue: event.status === "planned" && dateStatus === "past",
    summary: {
      eventDate: s.eventDate ?? null,
      eventDates: s.eventDates ?? [],
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
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
  };
}

// Row by row (in the order of event.rows), then left to right inside each row.
function sortWidgets(widgets, event = {}) {
  return inDisplayOrder(event, widgets);
}

function serializeWidget(widget, today = todayInTimezone()) {
  const base = {
    id: String(widget._id),
    eventId: String(widget.event),
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

module.exports = { serializeEvent, serializeWidget, sortWidgets, dateInfo };
