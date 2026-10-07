// Exercises the public-profile routes. The database is replaced with in-memory
// stand-ins; everything else is the real app, the real access rules and the
// real serializers.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const User = require("../models/User");
const Crumb = require("../models/Crumb");
const Collection = require("../models/Collection");
const Friendship = require("../models/Friendship");
const { pairKeyFor } = Friendship;
const app = require("../app");

const me = new mongoose.Types.ObjectId();
const them = new mongoose.Types.ObjectId();

// ---- In-memory stand-ins for the database -----------------------------------
let viewer;      // the signed-in user
let target;      // whose profile is being asked for
let friendship;  // null, "pending" or "accepted", between viewer and target
let crumbsOf;    // crumbs belonging to `target`
let sharedDocs;  // collections both viewer and target are part of

function userDoc(id, username, extra = {}) {
  return new User({
    _id: id,
    username,
    usernameLower: username.toLowerCase(),
    email: `${username}@example.com`,
    firstName: "",
    lastName: "",
    password: "x",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    ...extra,
  });
}

// requireAuth
User.findById = async (id) => (String(id) === String(viewer._id) ? viewer : null);

// findPerson(): look the profile up by username, case-insensitively.
User.findOne = async ({ usernameLower }) =>
  [viewer, target].find((u) => u && u.usernameLower === usernameLower) ?? null;

// loadPeople() (used by the collection payload)
User.find = () => ({ select: () => ({ lean: async () => [] }) });

// relationshipFor() and isFriend() both chain .select().lean() off findOne, so
// the stub must stay chainable even when nothing matches — returning a bare
// null would be a TypeError in the route, not a 404.
Friendship.findOne = ({ pairKey, status }) => {
  const matches =
    friendship && pairKey === pairKeyFor(viewer._id, target._id);
  const row = matches && (!status || status === friendship)
    ? { _id: new mongoose.Types.ObjectId(), status: friendship }
    : null;

  return { select: () => ({ lean: async () => row }) };
};

Friendship.find = () => ({
  lean: async () =>
    friendship === "accepted"
      ? [{ requester: viewer._id, recipient: target._id, status: "accepted" }]
      : [],
});

Crumb.find = () => ({
  sort: () => ({
    limit: () => ({
      lean: async () =>
        crumbsOf.map(
          (c) =>
            new Crumb({
              _id: new mongoose.Types.ObjectId(),
              user: target._id,
              filename: "a.png",
              url: "/uploads/a.png",
              mimeType: "image/png",
              size: 1,
              caption: c,
              createdAt: new Date(0),
            }),
        ),
    }),
  }),
});

const collectionDoc = (id, title) => ({
  _id: id,
  owner: target._id,
  collaborators: [viewer._id],
  title,
  description: "",
  tags: [],
  status: "draft",
  rows: [{ _id: new mongoose.Types.ObjectId(), name: "" }],
  summary: {},
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

Collection.find = () => ({ sort: () => ({ lean: async () => sharedDocs }) });

const cookie = `crumbs_token=${jwt.sign({ sub: String(me) }, process.env.JWT_SECRET)}`;

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test.beforeEach(() => {
  viewer = userDoc(me, "ann", { firstName: "Ann", lastName: "A" });
  target = userDoc(them, "jian");
  friendship = null;
  crumbsOf = [];
  sharedDocs = [];
});

async function get(path) {
  const res = await fetch(base + path, { headers: { Cookie: cookie } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ---- Anyone signed in can see the basics -------------------------------------
test("a non-friend sees identity but nothing private", async () => {
  const { status, json } = await get("/api/users/jian");

  assert.equal(status, 200);
  assert.equal(json.user.id, String(them));
  assert.equal(json.user.username, "jian");
  assert.equal(json.user.relationship, "none");
  assert.equal(json.user.isSelf, false);
  assert.equal(json.user.requestId, null);
});

test("a non-friend's friend count is null, not zero", async () => {
  // null means "not shown"; 0 would claim they have no friends, which is a leak.
  const { json } = await get("/api/users/jian");
  assert.equal(json.user.friendsCount, null);
});

test("an email is never returned, to anybody", async () => {
  for (const path of ["/api/users/jian", "/api/users/ann"]) {
    const { json } = await get(path);
    assert.equal(JSON.stringify(json).includes("email"), false, path);
    assert.equal(json.user.email, undefined, path);
  }
});

test("the username is matched without regard to case", async () => {
  const { status, json } = await get("/api/users/JIAN");
  assert.equal(status, 200);
  assert.equal(json.user.username, "jian");
});

test("an unknown username is a 404", async () => {
  const { status } = await get("/api/users/nobody");
  assert.equal(status, 404);
});

test("a blank username is refused with a 400", async () => {
  const { status } = await get("/api/users/%20");
  assert.equal(status, 400);
});

test("profiles need a signed-in user", async () => {
  const res = await fetch(base + "/api/users/jian");
  assert.equal(res.status, 401);
});

// ---- Friend-gated content ----------------------------------------------------
test("a non-friend cannot list another person's crumbs", async () => {
  crumbsOf = ["secret photo"];
  const { status } = await get("/api/users/jian/crumbs");
  assert.equal(status, 404);
});

test("a non-friend cannot list another person's collections", async () => {
  sharedDocs = [collectionDoc(new mongoose.Types.ObjectId(), "Secret")];
  const { status } = await get("/api/users/jian/collections");
  assert.equal(status, 404);
});

test("a friend sees those crumbs and collections", async () => {
  friendship = "accepted";
  crumbsOf = ["their photo"];

  const crumbs = await get("/api/users/jian/crumbs");
  assert.equal(crumbs.status, 200);
  assert.equal(crumbs.json.crumbs.length, 1);
  assert.equal(crumbs.json.crumbs[0].caption, "their photo");

  sharedDocs = [collectionDoc(new mongoose.Types.ObjectId(), "Weekend hike")];
  const collections = await get("/api/users/jian/collections");
  assert.equal(collections.status, 200);
  assert.equal(collections.json.collections[0].title, "Weekend hike");
});

test("a friend sees the real friend count", async () => {
  friendship = "accepted";
  const { json } = await get("/api/users/jian");
  assert.equal(json.user.friendsCount, 1);
  assert.equal(json.user.relationship, "friends");
});

test("a PENDING request does not unlock crumbs", async () => {
  // The whole point of the gate: a request I have not accepted reveals nothing.
  friendship = "pending";
  crumbsOf = ["their photo"];

  const profile = await get("/api/users/jian");
  assert.equal(profile.json.user.relationship, "request_received");
  assert.ok(profile.json.user.requestId, "the page needs the id to accept it");
  assert.equal(profile.json.user.friendsCount, null);

  const crumbs = await get("/api/users/jian/crumbs");
  assert.equal(crumbs.status, 404);
});

// ---- Your own profile --------------------------------------------------------
test("your own profile reports isSelf and shows you your crumbs", async () => {
  crumbsOf = ["mine"];

  const { json } = await get("/api/users/ann");
  assert.equal(json.user.isSelf, true);
  assert.equal(json.user.relationship, "self");

  const crumbs = await get("/api/users/ann/crumbs");
  assert.equal(crumbs.status, 200);
  assert.equal(crumbs.json.crumbs[0].caption, "mine");
});

test("you are never reported as your own friend", async () => {
  const { json } = await get("/api/users/ann");
  assert.equal(json.user.relationship, "self");
});

test("a third person's crumbs cannot be probed through a shared collection", async () => {
  // Someone we only share a collection with, looked up by their own username.
  target = userDoc(them, "collaborator");
  friendship = null;
  crumbsOf = ["theirs"];
  sharedDocs = [collectionDoc(new mongoose.Types.ObjectId(), "Theirs")];

  const { status } = await get("/api/users/collaborator/crumbs");
  assert.equal(status, 404);
});

test("sharing a collection does NOT make you friends", async () => {
  // Someone can be a collaborator on your collection and still see nothing.
  friendship = null;
  sharedDocs = [collectionDoc(new mongoose.Types.ObjectId(), "Theirs")];

  const { status } = await get("/api/users/jian/crumbs");
  assert.equal(status, 404);
});
