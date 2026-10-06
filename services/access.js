const Collection = require("../models/Collection");
const HttpError = require("../utils/httpError");

// Who may see and edit a collection: its creator, and the friends it was shared with.
// Spread this into any MongoDB filter:  Collection.find({ ...accessFilter(userId), status: "done" })
function accessFilter(userId) {
  return { $or: [{ owner: userId }, { collaborators: userId }] };
}

const isOwner = (collection, userId) => String(collection.owner) === String(userId);

// Finds a collection the user may edit. A collection the user has no part in gets the
// same 404 as one that does not exist, so ids cannot be probed.
async function findAccessibleCollection(id, userId) {
  const collection = await Collection.findOne({ _id: id, ...accessFilter(userId) }).lean();
  if (!collection) throw new HttpError(404, "Collection not found");
  return collection;
}

// Some actions belong to the creator alone (deleting, managing people).
function assertOwner(collection, userId, action) {
  if (!isOwner(collection, userId)) {
    throw new HttpError(403, `Only the creator can ${action}`);
  }
}

module.exports = { accessFilter, isOwner, findAccessibleCollection, assertOwner };
