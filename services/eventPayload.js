const User = require("../models/User");
const { todayInTimezone } = require("../utils/dates");
const { serializeEvent, serializeWidget, sortWidgets } = require("./serializers");

// Everything serializeEvent needs besides the event itself: today's date, who is
// asking, and the usernames of everyone who appears on these events (one query
// for all of them, not one per event).
async function eventContext(events, viewerId) {
  const ids = new Set();
  for (const event of events) {
    ids.add(String(event.owner));
    for (const id of event.collaborators ?? []) ids.add(String(id));
  }

  const users = ids.size
    ? await User.find({ _id: { $in: [...ids] } }).select("username").lean()
    : [];

  return {
    today: todayInTimezone(),
    viewerId: String(viewerId),
    people: new Map(users.map((u) => [String(u._id), { id: String(u._id), username: u.username }])),
  };
}

// The JSON for "one event plus its widgets".
async function eventPayload(event, widgets, viewerId) {
  const ctx = await eventContext([event], viewerId);
  return {
    event: serializeEvent(event, ctx),
    widgets: sortWidgets(widgets, event).map((widget) => serializeWidget(widget, ctx.today)),
  };
}

// The JSON for just the event (no widgets).
async function eventJson(event, viewerId) {
  return serializeEvent(event, await eventContext([event], viewerId));
}

// The JSON for a page of events (Collections, Search, Upcoming).
async function eventList(events, viewerId) {
  const ctx = await eventContext(events, viewerId);
  return events.map((event) => serializeEvent(event, ctx));
}

module.exports = { eventContext, eventPayload, eventJson, eventList };
