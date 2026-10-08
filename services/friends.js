const Friendship = require("../models/Friendship");
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
// Events can only be shared with friends, never with strangers.
async function assertCanInvite(ownerId, userIds) {
  const unique = [...new Set(userIds.map(String))];
  if (unique.length === 0) return [];

  if (unique.includes(String(ownerId))) {
    throw new HttpError(400, "You are already part of your own event", {
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

module.exports = { getFriendIds, assertCanInvite, relationshipOf };
