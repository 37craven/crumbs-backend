const test = require("node:test");
const assert = require("node:assert/strict");
const Friendship = require("../models/Friendship");
const Collection = require("../models/Collection");
const { pairKeyFor } = Friendship;
const { relationshipOf } = require("../services/friends");
const { accessFilter, isOwner, assertOwner } = require("../services/access");
const { sendRequestSchema, userSearchSchema } = require("../validators/friends");
const { createCollectionSchema, addCollaboratorSchema } = require("../validators/collection");
const { parseOrThrow } = require("../validators/common");

const A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbbbbbbbbbb";

test("a friendship between two people has the same key whichever way it was sent", () => {
  assert.equal(pairKeyFor(A, B), pairKeyFor(B, A));
  assert.equal(pairKeyFor(A, B), `${A}_${B}`);
});

test("friendship records reject self-requests and bad status values", async () => {
  const self = new Friendship({ requester: A, recipient: A });
  await assert.rejects(self.validate(), (e) => Boolean(e.errors.recipient));
  const bad = new Friendship({ requester: A, recipient: B, status: "blocked" });
  await assert.rejects(bad.validate(), (e) => Boolean(e.errors.status));
  const ok = new Friendship({ requester: A, recipient: B });
  await ok.validate();
  assert.equal(ok.status, "pending");
  assert.equal(ok.pairKey, pairKeyFor(A, B)); // set automatically
});

test("relationshipOf describes how two people are connected", () => {
  const rows = [
    { requester: A, recipient: B, status: "pending" },
    { requester: "c".repeat(24), recipient: A, status: "accepted" },
  ];
  assert.equal(relationshipOf(A, B, rows), "request_sent");
  assert.equal(relationshipOf(B, A, rows), "request_received");
  assert.equal(relationshipOf(A, "c".repeat(24), rows), "friends");
  assert.equal(relationshipOf(A, "d".repeat(24), rows), "none");
});

test("friend request and user search bodies are validated", () => {
  assert.throws(() => parseOrThrow(sendRequestSchema, {}), (e) => e.status === 400);
  assert.throws(() => parseOrThrow(sendRequestSchema, { userId: "nope" }), (e) => e.status === 400);
  assert.deepEqual(parseOrThrow(sendRequestSchema, { userId: A }), { userId: A });
  assert.throws(() => parseOrThrow(userSearchSchema, { q: "a" }), (e) => Boolean(e.fields.q));
  assert.equal(parseOrThrow(userSearchSchema, { q: " ma " }).q, "ma");
});

test("access: the creator and collaborators may edit; only the creator may delete or manage people", () => {
  assert.deepEqual(accessFilter(A), { $or: [{ owner: A }, { collaborators: A }] });
  const collection = { owner: A, collaborators: [B] };
  assert.equal(isOwner(collection, A), true);
  assert.equal(isOwner(collection, B), false);
  assert.doesNotThrow(() => assertOwner(collection, A, "delete this collection"));
  assert.throws(() => assertOwner(collection, B, "delete this collection"), (e) => e.status === 403 && /Only the creator can delete/.test(e.message));
});

test("collections can be shared at creation; duplicates and bad ids are handled", () => {
  const input = parseOrThrow(createCollectionSchema, { title: "T", collaborators: [A, B] });
  assert.deepEqual(input.collaborators, [A, B]);
  assert.deepEqual(parseOrThrow(createCollectionSchema, { title: "T" }).collaborators, []);
  assert.throws(() => parseOrThrow(createCollectionSchema, { title: "T", collaborators: ["nope"] }), (e) => e.status === 400);
  assert.throws(() => parseOrThrow(addCollaboratorSchema, {}), (e) => e.status === 400);
});

test("a collection cannot be shared with more than 20 people", async () => {
  const many = Array.from({ length: 21 }, (_, i) => String(i).padStart(24, "0"));
  const collection = new Collection({ owner: A, title: "T", collaborators: many });
  await assert.rejects(collection.validate(), (e) => Boolean(e.errors.collaborators));
  assert.throws(() => parseOrThrow(createCollectionSchema, { title: "T", collaborators: many }), (e) => e.status === 400);
});
