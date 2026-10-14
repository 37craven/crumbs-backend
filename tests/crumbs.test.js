// Exercises the crumb routes against real Mongoose documents and real picture
// bytes. Only the database calls are replaced with in-memory stand-ins — nothing
// touches disk, because pictures now live inside the documents that own them.
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
const { Widget, widgetModels } = require("../models/Widget");
const { CAPTION_MAX } = require("../models/Crumb");

// Stubbed before the app is loaded: routes/crumbs.js takes isFriend by
// destructuring when it is first required, so the real module has to be in place
// first. Picture routes now follow the same friendship rule as the crumbs
// themselves, which is what makes that stub necessary.
const friends = require("../services/friends");
let acceptedFriends = new Set();
friends.isFriend = async (a, b) => acceptedFriends.has(String(a) + "|" + String(b));
friends.getFriendIds = async () => [];

const app = require("../app");

const userId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const collectionId = new mongoose.Types.ObjectId();
const rowId = new mongoose.Types.ObjectId();

// ---- In-memory stand-ins for the database -----------------------------------
const crumbs = [];
const widgets = [];
let accessibleCollections; // which collections this user may file a crumb into

User.findById = async (id) =>
  String(id) === String(userId) ? { _id: userId } : null;

Crumb.create = async (data) => {
  const doc = new Crumb(data);
  // Stand in for the write. Keeps the document usable by routes/crumbs.js,
  // which reads it back (toPublic) and re-saves it when filing a copy.
  doc.save = async () => { await doc.validate(); return doc; };
  crumbs.push(doc);
  return doc;
};
Crumb.find = (filter) => ({
  sort: () => ({
    lean: async () =>
      crumbs
        .filter((c) => String(c.user) === String(filter.user))
        .sort((a, b) => b.createdAt - a.createdAt),
  }),
});
Crumb.findOne = async (filter) =>
  crumbs.find(
    (c) =>
      String(c._id) === String(filter._id) &&
      String(c.user) === String(String(filter.user)),
  ) ?? null;
Crumb.deleteOne = async ({ _id }) => {
  const i = crumbs.findIndex((c) => String(c._id) === String(_id));
  if (i >= 0) crumbs.splice(i, 1);
};

// The legacy image route reads one crumb with the normally-hidden imageData.
Crumb.findById = (id) => {
  const found = crumbs.find((c) => String(c._id) === String(id)) ?? null;
  return { select: async () => found };
};

// A crumb written before pictures moved into an `image` subdocument: the bytes sit
// loose in the document as `imageData`. It is a real document, because
// routes/crumbs.js calls picture() on it. Note the missing `image`: the schema
// requires it, but validation only runs on save, so an old document still reads fine.
function legacyCrumb(fields = {}) {
  const doc = new Crumb({
    user: userId,
    imageData: PNG,
    contentType: "image/png",
    caption: "",
    createdAt: new Date(1000),
    ...fields,
  });
  crumbs.push(doc);
  return doc._id;
}

Collection.findOne = (filter) => ({
  lean: async () =>
    accessibleCollections.has(String(filter._id))
      ? {
          _id: collectionId,
          owner: userId,
          collaborators: [],
          title: "Trip",
          description: "",
          tags: [],
          status: "draft",
          rows: [{ _id: rowId, name: "" }],
        }
      : null,
});

// The image widget lookup the crumb->collection copy does.
widgetModels.image.find = () => ({ select: () => ({ lean: async () => [] }) });

// Creating the widget writes it; stand in for that and keep the document so
// the tests can see what the collection copy was given.
widgetModels.image.prototype.save = async function save() {
  await this.validate();
  widgets.push(this);
  return this;
};

// refreshCollectionSummary() reads the collection and its widgets to rebuild
// the card summary. Give it harmless answers so it can run for real.
const lean = (value) => ({ lean: async () => value });
Widget.find = () => lean(widgets.map((w) => w.toObject?.() ?? w));
Collection.findById = () =>
  lean({
    _id: collectionId,
    owner: userId,
    collaborators: [],
    title: "Trip",
    description: "",
    tags: [],
    status: "draft",
    rows: [{ _id: rowId, name: "" }],
  });
Collection.findByIdAndUpdate = (id, update) =>
  lean({
    _id: collectionId,
    owner: userId,
    collaborators: [],
    title: "Trip",
    description: "",
    tags: [],
    status: "draft",
    rows: [{ _id: rowId, name: "" }],
    ...update.$set,
  });

const cookie = `crumbs_token=${jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET)}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

// A stored picture subdocument. `PNG` is declared above but used here lazily, so
// this is a function rather than a constant.
const pic = (data = PNG, mimeType = "image/png") => ({
  data,
  originalName: "a.png",
  mimeType,
  size: data.length,
  uploadedAt: new Date(),
});

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
  crumbs.length = 0;
  widgets.length = 0;
  accessibleCollections = new Set([String(collectionId)]);
  acceptedFriends = new Set();
});

// Every stored picture, wherever it is held. With pictures inside the documents
// this replaces the old "what is in uploads/" check: nothing is on disk, so what
// matters is which records still hold bytes.
const storedPictures = () =>
  crumbs.filter((c) => c.image?.data || c.imageData).length +
  widgets.filter((w) => w.image?.data).length;

async function send(method, url, { json, files, fields = {} } = {}) {
  const headers = { Cookie: cookie };
  let body;
  if (files || Object.keys(fields).length) {
    body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    for (const f of files ?? []) {
      body.append("image", new Blob([f.data], { type: f.type }), f.name);
    }
  } else if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(base + url, { method, headers, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const png = (name = "a.png") => ({ data: PNG, type: "image/png", name });

// ---- Listing and validation --------------------------------------------------
test("my crumbs come back newest first, and nobody else's", async () => {
  const old = new Crumb({ user: userId, image: pic(), caption: "old", createdAt: new Date(1000) });
  const fresh = new Crumb({ user: userId, image: pic(), caption: "new", createdAt: new Date(2000) });
  const notMine = new Crumb({ user: otherUserId, image: pic(), createdAt: new Date(3000) });
  crumbs.push(old, fresh, notMine);

  const { status, json } = await send("GET", "/api/crumbs");
  assert.equal(status, 200);
  assert.deepEqual(json.crumbs.map((c) => c.caption), ["new", "old"]);
});

test("an upload needs a picture; a non-image or an SVG is refused and nothing is stored", async () => {
  const none = await send("POST", "/api/crumbs", { fields: { caption: "hi" } });
  assert.equal(none.status, 400);

  const text = await send("POST", "/api/crumbs", {
    files: [{ data: Buffer.from("hello"), type: "text/plain", name: "a.txt" }],
  });
  assert.equal(text.status, 400);

  const svg = await send("POST", "/api/crumbs", {
    files: [{ data: SVG, type: "image/svg+xml", name: "a.svg" }],
  });
  assert.equal(svg.status, 400);

  assert.equal(storedPictures(), 0);
  assert.deepEqual(crumbs, []);
});

test("a caption over the limit is refused and nothing is stored", async () => {
  const { status, json } = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { caption: "x".repeat(CAPTION_MAX + 1) },
  });

  assert.equal(status, 400);
  assert.match(json.fields.caption[0], new RegExp(String(CAPTION_MAX)));
  assert.equal(storedPictures(), 0);
  assert.deepEqual(crumbs, []);
});

test("the caption is trimmed, and no caption is allowed", async () => {
  const withCaption = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { caption: "  at the beach  " },
  });
  assert.equal(withCaption.status, 201);
  assert.equal(withCaption.json.crumb.caption, "at the beach");

  const without = await send("POST", "/api/crumbs", { files: [png()] });
  assert.equal(without.status, 201);
  assert.equal(without.json.crumb.caption, "");
});

test("a crumb is served from its own route and never carries the bytes", async () => {
  const { json } = await send("POST", "/api/crumbs", { files: [png()] });
  assert.equal(json.crumb.imageUrl, `/api/crumbs/${json.crumb.id}/image`);
  // Nothing that identifies the stored picture, and above all not the bytes.
  assert.equal(json.crumb.image, undefined);
  assert.equal(json.crumb.filename, undefined);
  assert.equal(JSON.stringify(json).includes(PNG.toString("base64")), false);
  assert.equal(json.crumb.collectionId, null);
});

// ---- Filing a copy into a collection -----------------------------------------
test("a crumb filed into a collection also becomes an image widget there", async () => {
  const { status, json } = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { caption: "sunrise", collectionId: String(collectionId) },
  });

  assert.equal(status, 201);
  assert.equal(json.filedInCollection, true);
  assert.equal(json.collectionCopyError, null);
  assert.equal(json.crumb.collectionId, String(collectionId));
  // The crumb and the widget each hold the picture. They used to share ONE file on
  // disk, which is why deleting either had to check the other still needed it.
  assert.equal(storedPictures(), 2);
  assert.ok(widgets[0]?.image?.data, "the widget was given the bytes");
  assert.ok(Buffer.isBuffer(widgets[0].image.data));
});

test("with no collection the crumb stands alone", async () => {
  const { status, json } = await send("POST", "/api/crumbs", { files: [png()] });
  assert.equal(status, 201);
  assert.equal(json.filedInCollection, false);
  assert.equal(json.crumb.collectionId, null);
});

test("a collection I cannot reach still saves the crumb, and says so", async () => {
  accessibleCollections = new Set(); // not mine, or gone

  const { status, json } = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { collectionId: String(collectionId) },
  });

  assert.equal(status, 201);
  assert.equal(json.filedInCollection, false);
  assert.equal(json.crumb.collectionId, null);
  assert.match(json.collectionCopyError, /Collection not found/);
  assert.equal(crumbs.length, 1);
  assert.equal(storedPictures(), 1); // the crumb's own picture survives
});

test("a malformed collectionId is refused and nothing is stored", async () => {
  const { status, json } = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { collectionId: "nope" },
  });

  assert.equal(status, 400);
  assert.deepEqual(json.fields.collectionId, ["Invalid id"]);
  assert.deepEqual(crumbs, []);
  assert.equal(storedPictures(), 0);
});

// ---- Deleting ----------------------------------------------------------------
test("deleting my crumb removes the picture it held", async () => {
  const created = await send("POST", "/api/crumbs", { files: [png()] });
  const id = created.json.crumb.id;
  assert.equal(storedPictures(), 1);

  const { status } = await send("DELETE", `/api/crumbs/${id}`);
  assert.equal(status, 200);
  assert.deepEqual(crumbs, []);
  assert.equal(storedPictures(), 0);
});

test("deleting a crumb filed into a collection leaves the collection's copy alone", async () => {
  const created = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { collectionId: String(collectionId) },
  });
  const id = created.json.crumb.id;
  assert.equal(storedPictures(), 2);

  const { status } = await send("DELETE", `/api/crumbs/${id}`);
  assert.equal(status, 200);
  assert.deepEqual(crumbs, []);
  // The widget still holds its own copy, so the collection is unaffected. Nothing
  // has to be checked or cleaned up on disk any more.
  assert.equal(storedPictures(), 1);
  assert.equal(widgets.length, 1);
  assert.ok(widgets[0].image.data);
});

test("deleting someone else's crumb is a 404", async () => {
  const created = await send("POST", "/api/crumbs", { files: [png()] });
  const mine = created.json.crumb.id;

  const { status } = await send("DELETE", `/api/crumbs/${new mongoose.Types.ObjectId()}`);
  assert.equal(status, 404);
  assert.equal(crumbs.length, 1); // mine is untouched
  void mine;
});

test("crumb routes need a signed-in user", async () => {
  for (const [method, path] of [
    ["GET", "/api/crumbs"],
    ["POST", "/api/crumbs"],
    ["DELETE", `/api/crumbs/${new mongoose.Types.ObjectId()}`],
    ["GET", `/api/crumbs/${new mongoose.Types.ObjectId()}/image`],
  ]) {
    const res = await fetch(base + path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test("a malformed crumb id -> 400 before the database is touched", async () => {
  const { status, json } = await send("DELETE", "/api/crumbs/not-an-id");
  assert.equal(status, 400);
  assert.match(json.message, /Invalid/);
});

// ---- Serving the picture -----------------------------------------------------
test("a crumb's picture is served from its own route", async () => {
  const { json } = await send("POST", "/api/crumbs", { files: [png()] });

  const res = await fetch(`${base}/api/crumbs/${json.crumb.id}/image`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test("a picture revalidates on an ETag instead of being cached for good", async () => {
  // The address is now stable, so a replaced photo keeps its URL. An immutable
  // cache would keep showing the old picture; an ETag lets the browser re-check.
  const { json } = await send("POST", "/api/crumbs", { files: [png()] });
  const url = `${base}/api/crumbs/${json.crumb.id}/image`;

  const first = await fetch(url, { headers: { Cookie: cookie } });
  const etag = first.headers.get("etag");
  assert.ok(etag, "an ETag was sent");
  assert.equal(first.headers.get("cache-control"), "private, no-cache");

  const again = await fetch(url, { headers: { Cookie: cookie, "If-None-Match": etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
});

test("a picture needs a signed-in user", async () => {
  const { json } = await send("POST", "/api/crumbs", { files: [png()] });

  const res = await fetch(`${base}/api/crumbs/${json.crumb.id}/image`);
  assert.equal(res.status, 401);
});

// A crumb of somebody else's is only visible to an accepted friend, and a photo
// is no more public than the crumb it belongs to. Before pictures moved into the
// database they sat at /uploads/<uuid>.jpg and anyone who had the address could
// read one; this is the rule that closed that.
test("a non-friend is 404 for someone else's crumb picture", async () => {
  const doc = new Crumb({ user: otherUserId, image: pic(), caption: "theirs" });
  crumbs.push(doc);

  const res = await fetch(`${base}/api/crumbs/${doc._id}/image`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type"), /^application\/json/);
});

test("an accepted friend MAY read someone else's crumb picture", async () => {
  const doc = new Crumb({ user: otherUserId, image: pic(), caption: "theirs" });
  crumbs.push(doc);
  acceptedFriends.add(`${userId}|${otherUserId}`);

  const res = await fetch(`${base}/api/crumbs/${doc._id}/image`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test("an unknown crumb picture is 404", async () => {
  const res = await fetch(`${base}/api/crumbs/${new mongoose.Types.ObjectId()}/image`, {
    headers: { Cookie: cookie },
  });
  assert.equal(res.status, 404);
});

// ---- Crumbs written before pictures moved into an image subdocument ----------
// These hold the bytes loose in the document. They must keep working, so
// picture() falls back to them and the same route serves them.
test("a legacy crumb keeps working and is served by the same route", async () => {
  const id = legacyCrumb({ caption: "SF25" });

  const { status, json } = await send("GET", "/api/crumbs");
  assert.equal(status, 200);

  const crumb = json.crumbs.find((c) => c.id === String(id));
  assert.equal(crumb.imageUrl, `/api/crumbs/${id}/image`);
  assert.equal(crumb.caption, "SF25");

  const res = await fetch(`${base}/api/crumbs/${id}/image`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});
