const Event = require("../models/Event");
const HttpError = require("../utils/httpError");

// Who may see and edit an event: its creator, and the friends it was shared with.
// Spread this into any MongoDB filter:  Event.find({ ...accessFilter(userId), status: "done" })
function accessFilter(userId) {
  return { $or: [{ owner: userId }, { collaborators: userId }] };
}

const isOwner = (event, userId) => String(event.owner) === String(userId);

// Finds an event the user may edit. An event the user has no part in gets the
// same 404 as one that does not exist, so ids cannot be probed.
async function findAccessibleEvent(id, userId) {
  const event = await Event.findOne({ _id: id, ...accessFilter(userId) }).lean();
  if (!event) throw new HttpError(404, "Event not found");
  return event;
}

// Some actions belong to the creator alone (deleting, managing people).
function assertOwner(event, userId, action) {
  if (!isOwner(event, userId)) {
    throw new HttpError(403, `Only the creator can ${action}`);
  }
}

module.exports = { accessFilter, isOwner, findAccessibleEvent, assertOwner };
