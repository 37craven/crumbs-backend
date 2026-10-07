const express = require("express");
const User = require("../models/User");
const Crumb = require("../models/Crumb");
const Collection = require("../models/Collection");
const { requireAuth } = require("../middleware/auth");
const HttpError = require("../utils/httpError");
const { parseOrThrow } = require("../validators/common");
const { usernameParamSchema } = require("../validators/user");
const { isFriend, relationshipFor, getFriendIds } = require("../services/friends");
const { personSummary } = require("../services/people");
const { collectionContext, serializeCollection } = require("../services/collectionPayload");

const router = express.Router();

// Every profile needs a signed-in user: the response says how YOU are connected
// to the person, which only makes sense for a real account.
router.use(requireAuth);

// A crumb list on someone else's profile is capped, so one huge timeline cannot
// stall the page. Their own profile is not capped (see GET /api/crumbs).
const MAX_PROFILE_CRUMBS = 60;

// Finds a person by username, case-insensitively. `usernameLower` is indexed
// and unique, so this is one lookup.
//
// A non-friend still gets a profile: identity is public. What is NOT public is
// their crumbs and their friend count, and those are left out further down —
// the client cannot show what it was never sent.
async function findPerson(username) {
  const { username: wanted } = parseOrThrow(usernameParamSchema, { username });

  const user = await User.findOne({ usernameLower: wanted.toLowerCase() });
  if (!user) throw new HttpError(404, "No such user");

  return user;
}

// GET /api/users/:username — one person's profile.
//
// Shown to any signed-in user:
//   id, username, firstName, lastName, avatarUrl, createdAt
//   relationship: "friends" | "request_sent" | "request_received" | "none" | "self"
//   requestId, so the page can accept or cancel a pending request
//
// Shown ONLY to accepted friends (or to yourself):
//   friendsCount
//
// Never, to anyone: the email.
router.get("/:username", async (req, res) => {
  const user = await findPerson(req.params.username);
  const me = req.user._id;
  const isSelf = String(user._id) === String(me);

  const { relationship, requestId } = await relationshipFor(me, user._id);
  const maySeePrivate = isSelf || relationship === "friends";

  const profile = {
    ...personSummary(user),
    createdAt: user.createdAt,
    relationship,
    requestId,
    isSelf,
    // null rather than absent, so the client can tell "not shown" from "zero".
    friendsCount: maySeePrivate ? (await getFriendIds(user._id)).length : null,
  };

  res.json({ user: profile });
});

// GET /api/users/:username/crumbs — that person's crumbs.
//
// ONLY for accepted friends, or for yourself. A non-friend gets the same 404 a
// missing user gets, so crumbs cannot be probed for existence either.
router.get("/:username/crumbs", async (req, res) => {
  const user = await findPerson(req.params.username);
  const me = req.user._id;

  if (!(await isFriend(me, user._id)) && String(user._id) !== String(me)) {
    throw new HttpError(404, "No such user");
  }

  const crumbs = await Crumb.find({ user: user._id })
    .sort({ createdAt: -1 })
    .limit(MAX_PROFILE_CRUMBS)
    .lean();

  res.json({
    crumbs: crumbs.map((crumb) => new Crumb(crumb).toPublic()),
    truncated: crumbs.length === MAX_PROFILE_CRUMBS,
  });
});

// GET /api/users/:username/collections — the collections you and this person
// are both part of. Same friend-or-self gate as their crumbs.
router.get("/:username/collections", async (req, res) => {
  const user = await findPerson(req.params.username);
  const me = req.user._id;

  if (!(await isFriend(me, user._id)) && String(user._id) !== String(me)) {
    throw new HttpError(404, "No such user");
  }

  // "Shared" means the same rule everywhere else in the app: you are the owner
  // or a collaborator, and so are they. No new access rule is invented here.
  const documents = await Collection.find({
    $and: [{ $or: [{ owner: me }, { collaborators: me }] }, { $or: [{ owner: user._id }, { collaborators: user._id }] }],
  })
    .sort({ updatedAt: -1 })
    .lean();

  const ctx = await collectionContext(documents, me);
  res.json({ collections: documents.map((doc) => serializeCollection(doc, ctx)) });
});

module.exports = router;
