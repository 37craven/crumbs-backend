const express = require("express");
const User = require("../models/User");
const Friendship = require("../models/Friendship");
const { pairKeyFor } = require("../models/Friendship");
const { requireAuth } = require("../middleware/auth");
const { validateObjectIdParam } = require("../middleware/validateObjectId");
const HttpError = require("../utils/httpError");
const { parseOrThrow } = require("../validators/common");
const { sendRequestSchema, userSearchSchema } = require("../validators/friends");
const { getFriendIds, relationshipOf } = require("../services/friends");
const { PERSON_FIELDS, personSummary, loadPeople } = require("../services/people");
const { escapeRegex } = require("../services/collectionSearch");

const router = express.Router();

router.use(requireAuth);
router.param("id", validateObjectIdParam);
router.param("userId", validateObjectIdParam);

// What other users see about a person: id, username, names and photo, so a
// friend list can be rendered. NEVER the email — see services/people.js.
// loadPeople() already returns this shape, so its values are not wrapped again.

// GET /api/friends — my friends, alphabetically.
router.get("/", async (req, res) => {
  const ids = await getFriendIds(req.user._id);
  const users = await User.find({ _id: { $in: ids } })
    .select(PERSON_FIELDS)
    .sort({ usernameLower: 1 })
    .lean();

  res.json({ friends: users.map(personSummary) });
});

// GET /api/friends/requests — requests waiting for me, and ones I have sent.
router.get("/requests", async (req, res) => {
  const me = String(req.user._id);
  const rows = await Friendship.find({
    status: "pending",
    $or: [{ requester: me }, { recipient: me }],
  })
    .sort({ createdAt: -1 })
    .lean();

  const people = await loadPeople(
    rows.map((row) => (String(row.requester) === me ? row.recipient : row.requester)),
  );
  const shape = (row, otherId) => ({
    id: String(row._id),
    user: people.get(String(otherId)) ?? { id: String(otherId), username: null },
    createdAt: row.createdAt,
  });

  res.json({
    incoming: rows.filter((r) => String(r.recipient) === me).map((r) => shape(r, r.requester)),
    outgoing: rows.filter((r) => String(r.requester) === me).map((r) => shape(r, r.recipient)),
  });
});

// GET /api/friends/search?q=ma — find people by username to add as friends.
// Each result says how I am connected to them already.
router.get("/search", async (req, res) => {
  const { q } = parseOrThrow(userSearchSchema, req.query);
  const me = req.user._id;

  const users = await User.find({
    usernameLower: { $regex: escapeRegex(q.toLowerCase()) },
    _id: { $ne: me },
  })
    .select(PERSON_FIELDS)
    .sort({ usernameLower: 1 })
    .limit(10)
    .lean();

  const ids = users.map((user) => user._id);
  const friendships = await Friendship.find({
    $or: [
      { requester: me, recipient: { $in: ids } },
      { recipient: me, requester: { $in: ids } },
    ],
  }).lean();

  res.json({
    users: users.map((user) => ({
      ...personSummary(user),
      relationship: relationshipOf(me, user._id, friendships),
    })),
  });
});

// POST /api/friends/requests — send a friend request. Body: { "userId": "..." }
// If that person already asked ME, this accepts their request instead.
router.post("/requests", async (req, res) => {
  const { userId } = parseOrThrow(sendRequestSchema, req.body);
  const me = req.user._id;

  if (userId === String(me)) throw new HttpError(400, "You cannot add yourself as a friend");

  const target = await User.findById(userId).select(PERSON_FIELDS).lean();
  if (!target) throw new HttpError(404, "User not found");

  const existing = await Friendship.findOne({ pairKey: pairKeyFor(me, userId) });
  if (existing) {
    if (existing.status === "accepted") throw new HttpError(409, "You are already friends");
    if (String(existing.requester) === String(me)) {
      throw new HttpError(409, "You already sent this person a friend request");
    }
    existing.status = "accepted";
    await existing.save();
    return res.json({ message: "You are now friends", friend: personSummary(target) });
  }

  const request = await Friendship.create({ requester: me, recipient: userId });
  res.status(201).json({
    request: { id: String(request._id), user: personSummary(target), status: request.status },
  });
});

// PATCH /api/friends/requests/:id/accept — accept a request sent to me.
router.patch("/requests/:id/accept", async (req, res) => {
  const request = await Friendship.findOne({
    _id: req.params.id,
    recipient: req.user._id,
    status: "pending",
  });
  if (!request) throw new HttpError(404, "Friend request not found");

  request.status = "accepted";
  await request.save();

  const requester = await User.findById(request.requester).select(PERSON_FIELDS).lean();
  res.json({ message: "You are now friends", friend: personSummary(requester) });
});

// DELETE /api/friends/requests/:id — decline a request sent to me, or cancel one I sent.
router.delete("/requests/:id", async (req, res) => {
  const me = req.user._id;
  const request = await Friendship.findOneAndDelete({
    _id: req.params.id,
    status: "pending",
    $or: [{ requester: me }, { recipient: me }],
  });
  if (!request) throw new HttpError(404, "Friend request not found");

  res.json({
    message: String(request.requester) === String(me) ? "Request cancelled" : "Request declined",
  });
});

// DELETE /api/friends/:userId — stop being friends.
// Collections already shared stay shared; the creator can remove people from a collection.
router.delete("/:userId", async (req, res) => {
  const removed = await Friendship.findOneAndDelete({
    pairKey: pairKeyFor(req.user._id, req.params.userId),
    status: "accepted",
  });
  if (!removed) throw new HttpError(404, "You are not friends with that person");

  res.json({ message: "Friend removed" });
});

module.exports = router;
