// Exercises the suggestion ranking in services/suggestions.js. The database is
// replaced with in-memory stand-ins, so this covers the ordering and the
// exclusions — not the Mongo queries themselves, which no stubbed test can.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const User = require("../models/User");
const Friendship = require("../models/Friendship");
const Collection = require("../models/Collection");
const { suggestionsFor } = require("../services/suggestions");

const me = new mongoose.Types.ObjectId();
const mika = new mongoose.Types.ObjectId();
const jon = new mongoose.Types.ObjectId();
const ana = new mongoose.Types.ObjectId();
const remy = new mongoose.Types.ObjectId();
const nia = new mongoose.Types.ObjectId();
const sol = new mongoose.Types.ObjectId();

// The world: demo is friends with mika and jon; ana has asked demo to be their
// friend; remy and nia are friends of demo's friends; sol knows nobody.
let accepted;
let pending;
let strangers;
let collections;

const id = (value) => String(value);

function involves(row, who) {
  return id(row.requester) === id(who) || id(row.recipient) === id(who);
}

// Every account, for requireAuth.
User.findById = async (wanted) =>
  [me, mika, jon, ana, remy, nia, sol].find((user) => id(user) === id(wanted)) ?? null;

// The stub honours .sort() as well as .limit(), because the service relies on
// Mongo sorting before limiting: it takes the newest 60 strangers and only then
// ranks them.
User.find = ({ _id: { $nin } = {} }) => ({
  select: () => ({
    sort: (spec) => {
      const [field, direction] = Object.entries(spec)[0];
      return {
        limit: (n) => ({
          lean: async () => {
            const wanted = $nin.map(id);
            const rows = strangers
              .filter((person) => !wanted.includes(id(person._id)))
              .sort((a, b) =>
                a[field] < b[field] ? -direction : a[field] > b[field] ? direction : 0,
              );
            return rows.slice(0, n);
          },
        }),
      };
    },
  }),
});

// Friendship.find serves three differently shaped queries. Two of them look
// alike — getFriendIds and connectedIds both ask for "{ requester: me } or
// { recipient: me }" — so `status` is what tells them apart, and a $in list on
// both sides means the third query (between my friends and the candidates).
Friendship.find = (filter) => {
  const clause = filter.$or[0];
  // An ObjectId is typeof "object" too, so look for $in specifically.
  const bothIn = Object.values(clause).every((value) => value?.$in);

  let rows;
  if (bothIn) {
    const mine = clause.requester.$in.map(id);
    const theirs = clause.recipient.$in.map(id);
    rows = accepted.filter((row) => {
      const a = id(row.requester);
      const b = id(row.recipient);
      return (mine.includes(a) && theirs.includes(b)) || (mine.includes(b) && theirs.includes(a));
    });
  } else {
    const pool = filter.status === "pending" ? pending : accepted;
    rows = pool.filter((row) => involves(row, me));
  }

  return {
    select: () => ({ lean: async () => rows }),
    lean: async () => rows,
  };
};

// Only collections that involve both the signed-in user and a candidate can
// affect the ranking, so the stub ignores the exact $or shapes.
Collection.find = () => ({
  select: () => ({
    lean: async () =>
      collections.filter((collection) => {
        const members = [collection.owner, ...collection.collaborators].map(id);
        return (
          members.includes(id(me)) &&
          strangers.some((person) => members.includes(id(person._id)))
        );
      }),
  }),
});

function stranger(theId, username, createdAt) {
  return { _id: theId, username, usernameLower: username.toLowerCase(), createdAt };
}

test.beforeEach(() => {
  accepted = [
    { requester: me, recipient: mika },
    { requester: me, recipient: jon },
    { requester: mika, recipient: remy },
    { requester: mika, recipient: nia },
    { requester: jon, recipient: nia },
  ];
  pending = [{ requester: ana, recipient: me }];
  collections = [];
  strangers = [
    stranger(mika, "mika", 1),
    stranger(jon, "jon", 2),
    stranger(ana, "ana", 3),
    stranger(sol, "sol", 4),
    stranger(remy, "remy", 5),
    stranger(nia, "nia", 6),
  ];
});

test("suggestions never include yourself, your friends, or a pending request", async () => {
  const found = await suggestionsFor(me);

  // mika and jon are friends and ana has a request pending, so only the other
  // three are strangers.
  assert.deepEqual(
    found.map((entry) => entry.user.username).sort(),
    ["nia", "remy", "sol"],
  );
});

test("suggestions are ordered by mutual friends first, then newest", async () => {
  const found = await suggestionsFor(me);

  // nia is a friend of both mika and jon, remy of only mika, and sol of nobody.
  assert.deepEqual(
    found.map((entry) => entry.user.username),
    ["nia", "remy", "sol"],
  );
  assert.deepEqual(
    found.map((entry) => entry.reason),
    ["2 mutual friends", "1 mutual friend", "New on Crumbs"],
  );
});

test("a shared collection is a reason, and outranks being new", async () => {
  // No mutual friends left, so the only thing telling the strangers apart is
  // that sol is in a collection with demo. sol is the OLDEST of the three, so
  // this also shows the collection beats plain recency.
  accepted = [
    { requester: me, recipient: mika },
    { requester: me, recipient: jon },
  ];
  collections = [{ owner: me, collaborators: [sol] }];

  const found = await suggestionsFor(me);

  assert.deepEqual(
    found.map((entry) => entry.user.username),
    ["sol", "nia", "remy"],
  );
  assert.deepEqual(
    found.map((entry) => entry.reason),
    ["1 shared collection", "New on Crumbs", "New on Crumbs"],
  );
});

test("mutual friends outrank a shared collection", async () => {
  // nia has two mutual friends (200) and shares a collection (10). remy has one
  // mutual friend (100) and shares nothing, so nia still leads: one mutual
  // friend is worth more than any pile of shared collections.
  collections = [{ owner: me, collaborators: [nia] }];

  const found = await suggestionsFor(me);

  assert.deepEqual(
    found.map((entry) => entry.user.username),
    ["nia", "remy", "sol"],
  );
  assert.equal(found[0].reason, "2 mutual friends");
});

test("the list is capped at ten, oldest cut first", async () => {
  strangers = Array.from({ length: 70 }, (_, i) =>
    stranger(new mongoose.Types.ObjectId(), `user${String(i).padStart(2, "0")}`, i),
  );

  const found = await suggestionsFor(me, { limit: 10 });

  assert.equal(found.length, 10);
  // Nothing scores, so the newest ten win: user69 is the newest of the 70.
  assert.deepEqual(
    found.map((entry) => entry.user.username),
    Array.from({ length: 10 }, (_, i) => `user${String(69 - i).padStart(2, "0")}`),
  );
  assert.ok(found.every((entry) => entry.reason === "New on Crumbs"));
});

test("nobody left to meet -> an empty list, not an error", async () => {
  strangers = [stranger(mika, "mika", 1), stranger(jon, "jon", 2), stranger(ana, "ana", 3)];

  assert.deepEqual(await suggestionsFor(me), []);
});

test("an account with no friends suggests the newest people first", async () => {
  accepted = [];
  pending = [];
  // remy and nia were only reachable through mutual friends; on their own they
  // are just strangers, so the newest decides.
  strangers = [
    stranger(remy, "remy", 1),
    stranger(nia, "nia", 2),
    stranger(sol, "sol", 3),
  ];

  const found = await suggestionsFor(me);

  assert.deepEqual(
    found.map((entry) => entry.user.username),
    ["sol", "nia", "remy"],
  );
  assert.ok(found.every((entry) => entry.reason === "New on Crumbs"));
});
