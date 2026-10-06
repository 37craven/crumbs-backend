const User = require("../models/User");
const { todayInTimezone } = require("../utils/dates");
const { serializeCollection, serializeWidget, sortWidgets } = require("./serializers");

// Everything serializeCollection needs besides the collection itself: today's date, who is
// asking, and the usernames of everyone who appears on these collections (one query
// for all of them, not one per collection).
async function collectionContext(collections, viewerId) {
  const ids = new Set();
  for (const collection of collections) {
    ids.add(String(collection.owner));
    for (const id of collection.collaborators ?? []) ids.add(String(id));
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

// The JSON for "one collection plus its widgets".
async function collectionPayload(collection, widgets, viewerId) {
  const ctx = await collectionContext([collection], viewerId);
  return {
    collection: serializeCollection(collection, ctx),
    widgets: sortWidgets(widgets, collection).map((widget) => serializeWidget(widget, ctx.today)),
  };
}

// The JSON for just the collection (no widgets).
async function collectionJson(collection, viewerId) {
  return serializeCollection(collection, await collectionContext([collection], viewerId));
}

// The JSON for a page of collections (Collections, Search, Upcoming).
async function collectionList(collections, viewerId) {
  const ctx = await collectionContext(collections, viewerId);
  return collections.map((collection) => serializeCollection(collection, ctx));
}

module.exports = { collectionContext, collectionPayload, collectionJson, collectionList };
