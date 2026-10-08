// Exercises GET /api/friends/suggestions. The database is replaced with
// in-memory stand-ins; everything else is the real app and the real serializers.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const User = require("../models/User");
const Friendship = require("../models/Friendship");
const app = require("../app");

const oid = () => new mongoose.Types.ObjectId();
const me = oid();

// ---- In-memory stand-ins for the database -----------------------------------
let viewer; //       the signed-in user
let rows; //         every friendship row that involves the viewer
let sampled; //      what $sample "randomly" returns: user ids
let directory; //    lean user records, as loadPeople() reads them
let pipeline; //     the aggregation the route asked for

// requireAuth
User.findById = async (id) => (String(id) === String(viewer._id) ? viewer : null);

Friendship.find = () => ({ lean: async () => rows });

User.aggregate = async (stages) => {
  pipeline = stages;
  return sampled.map((id) => ({ _id: id }));
};

// loadPeople()
User.find = () => ({
  select: () => ({ lean: async () => directory }),
});

const person = (id, username, extra = {}) => ({
  _id: id,
  username,
  usernameLower: username.toLowerCase(),
  email: `${username}@example.com`,
  firstName: "",
  lastName: "",
  ...extra,
});

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
  viewer = new User(person(me, "ann"));
  rows = [];
  sampled = [];
  directory = [];
  pipeline = null;
});

async function suggestions() {
  const res = await fetch(`${base}/api/friends/suggestions`, { headers: { Cookie: cookie } });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test("suggestions need a signed-in user", async () => {
  const res = await fetch(`${base}/api/friends/suggestions`);
  assert.equal(res.status, 401);
});

test("it asks the database for a random sample of exactly 5 people", async () => {
  await suggestions();

  const sample = pipeline.find((stage) => stage.$sample);
  assert.deepEqual(sample, { $sample: { size: 5 } });
});

test("it never offers me, my friends, or anyone with a pending request", async () => {
  const friend = oid();
  const iAsked = oid();
  const askedMe = oid();
  rows = [
    { requester: me, recipient: friend, status: "accepted" },
    { requester: me, recipient: iAsked, status: "pending" },
    { requester: askedMe, recipient: me, status: "pending" },
  ];

  await suggestions();

  const { $match } = pipeline.find((stage) => stage.$match);
  const excluded = $match._id.$nin.map(String).sort();
  assert.deepEqual(excluded, [me, friend, iAsked, askedMe].map(String).sort());
  // ids must be real ObjectIds: aggregate() does not cast strings the way find() does.
  assert.ok($match._id.$nin.every((id) => id instanceof mongoose.Types.ObjectId));
});

test("each suggestion carries a username and photo, and never an email", async () => {
  const a = oid();
  const b = oid();
  sampled = [a, b];
  directory = [
    person(a, "maya", { firstName: "Maya", avatar: { url: "/uploads/maya.jpg", filename: "x", mimeType: "image/jpeg" } }),
    person(b, "noah"),
  ];

  const { status, json } = await suggestions();

  assert.equal(status, 200);
  assert.equal(json.suggestions.length, 2);
  assert.deepEqual(json.suggestions[0], {
    id: String(a),
    username: "maya",
    firstName: "Maya",
    lastName: "",
    avatarUrl: "/uploads/maya.jpg",
  });
  assert.equal(json.suggestions[1].avatarUrl, null);
  assert.equal(JSON.stringify(json).includes("email"), false);
});

test("suggestions keep the order the sample came back in", async () => {
  const [a, b, c] = [oid(), oid(), oid()];
  sampled = [c, a, b];
  // The directory lookup returns them in a different order on purpose.
  directory = [person(a, "aa"), person(b, "bb"), person(c, "cc")];

  const { json } = await suggestions();

  assert.deepEqual(
    json.suggestions.map((s) => s.username),
    ["cc", "aa", "bb"],
  );
});

test("when nobody is left to suggest, the list is empty rather than an error", async () => {
  sampled = [];

  const { status, json } = await suggestions();

  assert.equal(status, 200);
  assert.deepEqual(json.suggestions, []);
});
