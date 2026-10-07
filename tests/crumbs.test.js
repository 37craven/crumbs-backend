// Exercises the crumb routes against real files on disk and real Mongoose
// documents. Only the database calls are replaced with in-memory stand-ins.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crumbs-crumbs-"));

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

// A crumb written before pictures moved onto disk: a Buffer in the document
// and no url. It is a real document, because routes/crumbs.js calls isLegacy()
// on it. Note the missing `url` and `filename`: the schema requires them, but
// validation only runs on save, so an old document still reads fine.
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
widgetModels.image.exists = async ({ "image.filename": filename }) =>
  widgets.some((w) => w.image?.filename === filename) ? { _id: 1 } : null;

// Creating the widget writes it; stand in for that and keep the document so
// the shared-file checks can see it.
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

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});
test.beforeEach(() => {
  crumbs.length = 0;
  widgets.length = 0;
  accessibleCollections = new Set([String(collectionId)]);
  for (const f of fs.readdirSync(process.env.UPLOAD_DIR)) {
    fs.unlinkSync(path.join(process.env.UPLOAD_DIR, f));
  }
});

const filesOnDisk = () => fs.readdirSync(process.env.UPLOAD_DIR);

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
  const old = new Crumb({ user: userId, filename: "old.png", url: "/uploads/old.png", mimeType: "image/png", caption: "old", createdAt: new Date(1000) });
  const fresh = new Crumb({ user: userId, filename: "new.png", url: "/uploads/new.png", mimeType: "image/png", caption: "new", createdAt: new Date(2000) });
  const notMine = new Crumb({ user: otherUserId, filename: "x.png", url: "/uploads/x.png", mimeType: "image/png", createdAt: new Date(3000) });
  crumbs.push(old, fresh, notMine);

  const { status, json } = await send("GET", "/api/crumbs");
  assert.equal(status, 200);
  assert.deepEqual(json.crumbs.map((c) => c.caption), ["new", "old"]);
});

test("an upload needs a picture; a non-image or an SVG is refused and nothing is left on disk", async () => {
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

  assert.deepEqual(filesOnDisk(), []);
  assert.deepEqual(crumbs, []);
});

test("a caption over the limit is refused and the uploaded file is cleaned up", async () => {
  const { status, json } = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { caption: "x".repeat(CAPTION_MAX + 1) },
  });

  assert.equal(status, 400);
  assert.match(json.fields.caption[0], new RegExp(String(CAPTION_MAX)));
  assert.deepEqual(filesOnDisk(), []);
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

test("a crumb never exposes the name of the file on disk", async () => {
  const { json } = await send("POST", "/api/crumbs", { files: [png()] });
  assert.match(json.crumb.imageUrl, /^\/uploads\/[\w-]+\.png$/);
  assert.equal(json.crumb.filename, undefined);
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
  assert.equal(filesOnDisk().length, 1); // ONE file, shared by both records
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
  assert.equal(filesOnDisk().length, 1); // the crumb's own file survives
});

test("a malformed collectionId is refused and the file is cleaned up", async () => {
  const { status, json } = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { collectionId: "nope" },
  });

  assert.equal(status, 400);
  assert.deepEqual(json.fields.collectionId, ["Invalid id"]);
  assert.deepEqual(crumbs, []);
  assert.deepEqual(filesOnDisk(), []);
});

// ---- Deleting, and the shared file -------------------------------------------
test("deleting my crumb takes the file with it when no collection copy exists", async () => {
  const created = await send("POST", "/api/crumbs", { files: [png()] });
  const id = created.json.crumb.id;
  assert.equal(filesOnDisk().length, 1);

  const { status } = await send("DELETE", `/api/crumbs/${id}`);
  assert.equal(status, 200);
  assert.deepEqual(crumbs, []);
  assert.deepEqual(filesOnDisk(), []);
});

test("deleting a crumb that was filed into a collection KEEPS the shared file", async () => {
  const created = await send("POST", "/api/crumbs", {
    files: [png()],
    fields: { collectionId: String(collectionId) },
  });
  const id = created.json.crumb.id;
  const [onDisk] = filesOnDisk();

  // The upload really did produce an image widget holding this file.
  assert.equal(filesOnDisk().length, 1);
  widgets.push({ image: { filename: onDisk } });

  const { status } = await send("DELETE", `/api/crumbs/${id}`);
  assert.equal(status, 200);
  assert.deepEqual(crumbs, []);
  assert.deepEqual(
    filesOnDisk(),
    [onDisk],
    "the collection copy still needs the file, so it must not be unlinked",
  );
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

// ---- Crumbs written before pictures moved onto disk ---------------------------
// These hold a Buffer in the document and have no url. They must keep working,
// so toPublic() points at the legacy image route and that route serves the
// bytes.
test("a legacy crumb falls back to its own image route", async () => {
  const id = legacyCrumb({ caption: "SF25" });

  const { status, json } = await send("GET", "/api/crumbs");
  assert.equal(status, 200);

  const crumb = json.crumbs.find((c) => c.id === String(id));
  assert.equal(crumb.imageUrl, `/api/crumbs/${id}/image`);
  assert.equal(crumb.caption, "SF25");
});

test("a modern crumb is NOT given the legacy url", async () => {
  await send("POST", "/api/crumbs", { files: [png()] });

  const { json } = await send("GET", "/api/crumbs");
  assert.match(json.crumbs[0].imageUrl, /^\/uploads\/[\w-]+\.png$/);
});

test("the legacy image route serves the stored bytes", async () => {
  const id = legacyCrumb();

  const res = await fetch(`${base}/api/crumbs/${id}/image`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
});

test("the legacy image route needs no sign-in, so a photo can load in an <img>", async () => {
  const id = legacyCrumb();

  const res = await fetch(`${base}/api/crumbs/${id}/image`);
  assert.equal(res.status, 200);
});

test("a modern crumb is 404 on the legacy route; its picture lives in /uploads", async () => {
  const created = await send("POST", "/api/crumbs", { files: [png()] });

  const res = await fetch(`${base}/api/crumbs/${created.json.crumb.id}/image`);
  assert.equal(res.status, 404);
});

test("the legacy image route 404s an unknown crumb", async () => {
  const res = await fetch(`${base}/api/crumbs/${new mongoose.Types.ObjectId()}/image`);
  assert.equal(res.status, 404);
});
