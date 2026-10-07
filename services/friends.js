const Friendship = require("../models/Friendship");
const { pairKeyFor } = Friendship;
const HttpError = require("../utils/httpError");

// Ids of everyone the user is friends with (accepted friendships only).
async function getFriendIds(userId) {
  const rows = await Friendship.find({
    status: "accepted",
    $or: [{ requester: userId }, { recipient: userId }],
  }).lean();

  return rows.map((row) =>
    String(row.requester) === String(userId) ? row.recipient : row.requester,
  );
}

// Checks that every id is on the creator's friends list. Returns the ids
// without duplicates, or throws a 400 naming the problem.
// Collections can only be shared with friends, never with strangers.
async function assertCanInvite(ownerId, userIds) {
  const unique = [...new Set(userIds.map(String))];
  if (unique.length === 0) return [];

  if (unique.includes(String(ownerId))) {
    throw new HttpError(400, "You are already part of your own collection", {
      collaborators: ["You cannot add yourself"],
    });
  }

  const friends = new Set((await getFriendIds(ownerId)).map(String));
  const strangers = unique.filter((id) => !friends.has(id));
  if (strangers.length > 0) {
    throw new HttpError(400, "You can only add people from your friends list", {
      collaborators: strangers.map((id) => `${id} is not on your friends list`),
    });
  }

  return unique;
}

// How the logged-in user is connected to another user.
function relationshipOf(userId, otherId, friendships) {
  const row = friendships.find(
    (f) =>
      (String(f.requester) === String(userId) && String(f.recipient) === String(otherId)) ||
      (String(f.recipient) === String(userId) && String(f.requester) === String(otherId)),
  );
  if (!row) return "none";
  if (row.status === "accepted") return "friends";
  return String(row.requester) === String(userId) ? "request_sent" : "request_received";
}

// Are these two people accepted friends? One indexed lookup: pairKey is unique,
// so there can only ever be one record for the pair.
async function isFriend(userId, otherId) {
  if (String(userId) === String(otherId)) return false;

  const row = await Friendship.findOne({
    pairKey: pairKeyFor(userId, otherId),
    status: "accepted",
  })
    .select("_id")
    .lean();

  return Boolean(row);
}

// How `userId` is connected to `otherId`: "friends", "request_sent",
// "request_received" or "none". Also returns the pending request's id, because
// the caller needs it to accept or cancel one.
async function relationshipFor(userId, otherId) {
  if (String(userId) === String(otherId)) return { relationship: "self", requestId: null };

  const row = await Friendship.findOne({ pairKey: pairKeyFor(userId, otherId) })
    .select("_id status requester recipient")
    .lean();

  if (!row) return { relationship: "none", requestId: null };
  if (row.status === "accepted") return { relationship: "friends", requestId: null };

  const mine = String(row.requester) === String(userId);
  return {
    relationship: mine ? "request_sent" : "request_received",
    requestId: String(row._id),
  };
}

module.exports = {
  getFriendIds,
  assertCanInvite,
  relationshipOf,
  isFriend,
  relationshipFor,
};
