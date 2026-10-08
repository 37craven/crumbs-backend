const User = require("../models/User");
const Friendship = require("../models/Friendship");
const Collection = require("../models/Collection");
const { getFriendIds } = require("./friends");
const { PERSON_FIELDS } = require("./people");

// The most suggestions a client ever gets. The UI shows between 5 and 10.
const MAX_SUGGESTIONS = 10;

// How many strangers to consider before ranking them. Larger than the answer,
// because the best candidates are not necessarily the newest: if the 60 newest
// people include twelve who share a collection with you and the ten best are in
// there, fine, but the ten newest overall may never have been scored at all.
const POOL_SIZE = 60;

// Mutual friends are a far stronger signal than a shared collection, so one of
// them outranks a whole pile of shared collections. Recency only breaks ties.
const MUTUAL_WEIGHT = 100;
const SHARED_COLLECTION_WEIGHT = 10;

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// Why this person is being suggested. Sent with the person so the UI can say
// something other than "trust me".
function reasonFor(mutualCount, sharedCount) {
  if (mutualCount > 0) {
    return `${plural(mutualCount, "mutual friend", "mutual friends")}`;
  }
  if (sharedCount > 0) {
    return `${plural(sharedCount, "shared collection", "shared collections")}`;
  }
  return "New on Crumbs";
}

// Everyone the user is already connected to: themselves, their friends, and
// anyone with a request pending in either direction. Suggesting a friend, or
// someone whose request is already sitting in their profile page waiting to be
// accepted, would be noise.
async function connectedIds(userId) {
  const me = String(userId);

  const [friendIds, pending] = await Promise.all([
    getFriendIds(userId),
    Friendship.find({
      status: "pending",
      $or: [{ requester: me }, { recipient: me }],
    }).lean(),
  ]);

  return [
    ...new Set([
      me,
      ...friendIds.map(String),
      ...pending.flatMap((row) => [String(row.requester), String(row.recipient)]),
    ]),
  ];
}

// How many of my friends are also friends with each candidate: "friends of
// friends", the signal people actually recognise.
async function mutualFriendCounts(candidateIds, myFriendIds) {
  const counts = new Map(candidateIds.map((id) => [id, 0]));
  if (candidateIds.length === 0 || myFriendIds.length === 0) return counts;

  const links = await Friendship.find({
    status: "accepted",
    $or: [
      { requester: { $in: myFriendIds }, recipient: { $in: candidateIds } },
      { requester: { $in: candidateIds }, recipient: { $in: myFriendIds } },
    ],
  })
    .select("requester recipient")
    .lean();

  const mine = new Set(myFriendIds);
  for (const link of links) {
    const a = String(link.requester);
    const b = String(link.recipient);
    // Whichever end is not one of my friends is the candidate being scored.
    if (counts.has(a) && mine.has(b)) counts.set(a, counts.get(a) + 1);
    else if (counts.has(b) && mine.has(a)) counts.set(b, counts.get(b) + 1);
  }

  return counts;
}

// How many collections we are both part of. Note this is a weak signal by
// design: a collection can only be shared with friends (see assertCanInvite), so
// normally sharing one means you are already friends and already excluded. It
// earns its place for people whose friendship was removed while the shared
// collection stayed, which the API deliberately allows.
async function sharedCollectionCounts(candidateIds, userId) {
  const counts = new Map(candidateIds.map((id) => [id, 0]));
  if (candidateIds.length === 0) return counts;

  const shared = await Collection.find({
    $and: [
      { $or: [{ owner: userId }, { collaborators: userId }] },
      {
        $or: [
          { owner: { $in: candidateIds } },
          { collaborators: { $in: candidateIds } },
        ],
      },
    ],
  })
    .select("owner collaborators")
    .lean();

  for (const collection of shared) {
    const members = [String(collection.owner), ...collection.collaborators.map(String)];
    for (const member of members) {
      if (counts.has(member)) counts.set(member, counts.get(member) + 1);
    }
  }

  return counts;
}

// People the user might know, best first. Never yourself, never anyone you are
// already connected to — see connectedIds(). Returns { user, reason } pairs, so
// the caller can wrap the user with personSummary() the way every other
// person-shaped response is built.
async function suggestionsFor(userId, { limit = MAX_SUGGESTIONS } = {}) {
  const taken = await connectedIds(userId);

  const pool = await User.find({ _id: { $nin: taken } })
    .select(PERSON_FIELDS)
    .sort({ createdAt: -1, _id: 1 })
    .limit(Math.max(POOL_SIZE, limit))
    .lean();

  if (pool.length === 0) return [];

  const candidateIds = pool.map((user) => String(user._id));
  const myFriendIds = [...new Set((await getFriendIds(userId)).map(String))];

  const [mutuals, shared] = await Promise.all([
    mutualFriendCounts(candidateIds, myFriendIds),
    sharedCollectionCounts(candidateIds, userId),
  ]);

  const ranked = pool.map((user) => {
    const id = String(user._id);
    const mutualCount = mutuals.get(id) ?? 0;
    const sharedCount = shared.get(id) ?? 0;

    return {
      user,
      score: mutualCount * MUTUAL_WEIGHT + sharedCount * SHARED_COLLECTION_WEIGHT,
      createdAt: user.createdAt ?? 0,
      reason: reasonFor(mutualCount, sharedCount),
    };
  });

  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.createdAt - a.createdAt ||
        String(a.user.usernameLower).localeCompare(String(b.user.usernameLower)),
    )
    .slice(0, limit)
    .map((entry) => ({ user: entry.user, reason: entry.reason }));
}

module.exports = { suggestionsFor, MAX_SUGGESTIONS, POOL_SIZE };
