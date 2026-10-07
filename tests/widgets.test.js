// Exercises the widget routes with real files on disk and real Mongoose
// documents. Only the database calls are replaced with in-memory stand-ins.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crumbs-uploads-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const User = require("../models/User");
const Collection = require("../models/Collection");
const { Widget, widgetModels } = require("../models/Widget");
const app = require("../app");

const ownerId = new mongoose.Types.ObjectId();
const collectionId = new mongoose.Types.ObjectId();
const rowId = new mongoose.Types.ObjectId();

// ---- In-memory stand-ins for the database -----------------------------------
const docs = new Map();
const allowedUsers = new Set([String(ownerId)]); // who may edit the (single) collection
function makeWidget(type, fields = {}) {
  const doc = new widgetModels[type]({ collectionId, row: rowId, createdBy: ownerId, order: 0, ...fields });
  doc.save = async () => { await doc.validate(); return doc; }; // validate, don't write
  docs.set(String(doc._id), doc);
  return doc;
}
User.findById = async () => ({ _id: ownerId, toPublic: () => ({}) });
Widget.findById = async (id) => docs.get(String(id)) ?? null;
Widget.deleteOne = async ({ _id }) => { docs.delete(String(_id)); };
// The access check asks "is this user the owner or a collaborator of the collection?"
Collection.exists = async (filter) =>
  filter.$or.some((clause) => Object.values(clause).some((id) => allowedUsers.has(String(id))))
    ? { _id: filter._id }
    : null;
// refreshCollectionSummary() and the response builder read these; give them something harmless.
const lean = (value) => ({ lean: async () => value });
const collectionDoc = () => ({ _id: collectionId, owner: ownerId, collaborators: [], title: "T", description: "", tags: [], status: "draft", rows: [{ _id: rowId, name: "" }] });
Collection.findById = () => lean(collectionDoc());
Widget.find = () => lean([...docs.values()].map((d) => d.toObject()));
Collection.findByIdAndUpdate = (id, update) => lean({ ...collectionDoc(), ...update.$set });
User.find = () => ({ select: () => lean([]) });

const cookie = `crumbs_token=${jwt.sign({ sub: String(ownerId) }, process.env.JWT_SECRET)}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });
test.beforeEach(() => {
  docs.clear();
  allowedUsers.clear();
  allowedUsers.add(String(ownerId));
  for (const f of fs.readdirSync(process.env.UPLOAD_DIR)) fs.unlinkSync(path.join(process.env.UPLOAD_DIR, f));
});

const filesOnDisk = () => fs.readdirSync(process.env.UPLOAD_DIR);

async function send(method, url, { json, files, field = "image" } = {}) {
  const headers = { Cookie: cookie };
  let body;
  if (files) {
    body = new FormData();
    for (const f of files) body.append(field, new Blob([f.data], { type: f.type }), f.name);
  } else if (json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(base + url, { method, headers, body });
  return { status: res.status, json: await res.json().catch(() => null), res };
}
const png = (name = "a.png") => ({ data: PNG, type: "image/png", name });

// ---- The single picture of an image widget --------------------------------------
test("uploading a picture stores the file, serves it, and updates the collection cover", async () => {
  const widget = makeWidget("image");
  const { status, json } = await send("POST", `/api/widgets/${widget._id}/image`, { files: [png()] });

  assert.equal(status, 201);
  assert.match(json.widget.image.url, /^\/uploads\/[\w-]+\.png$/);
  assert.equal(json.widget.image.filename, undefined); // disk name stays private
  assert.equal(json.widget.rowId, String(rowId));
  assert.equal(json.collection.summary.imageCount, 1);
  assert.deepEqual(json.collection.summary.tiles.find((t) => t.type === "image"), { type: "image", url: json.widget.image.url });
  assert.equal(filesOnDisk().length, 1);

  const served = await fetch(base + json.widget.image.url);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
});

test("uploading again REPLACES the picture and deletes the old file", async () => {
  const widget = makeWidget("image");
  const first = await send("POST", `/api/widgets/${widget._id}/image`, { files: [png("one.png")] });
  const second = await send("POST", `/api/widgets/${widget._id}/image`, { files: [png("two.png")] });

  assert.equal(second.status, 201);
  assert.equal(second.json.widget.image.originalName, "two.png");
  assert.notEqual(second.json.widget.image.url, first.json.widget.image.url);
  assert.equal(filesOnDisk().length, 1); // only the new one remains
  assert.ok(!filesOnDisk().includes(path.basename(first.json.widget.image.url)));
});

test("removing the picture empties the widget but keeps it", async () => {
  const widget = makeWidget("image");
  await send("POST", `/api/widgets/${widget._id}/image`, { files: [png()] });

  const removed = await send("DELETE", `/api/widgets/${widget._id}/image`);
  assert.equal(removed.status, 200);
  assert.equal(removed.json.widget.image, null);
  assert.equal(removed.json.collection.summary.imageCount, 0);
  assert.equal(filesOnDisk().length, 0);
  assert.ok(docs.has(String(widget._id))); // the widget is still there

  assert.equal((await send("DELETE", `/api/widgets/${widget._id}/image`)).status, 404); // nothing left to remove
});

test("non-image files and SVGs are rejected and nothing is left on disk", async () => {
  const widget = makeWidget("image");
  for (const file of [{ data: Buffer.from("hello"), type: "text/plain", name: "notes.txt" }, { data: Buffer.from("<svg onload=alert(1)/>"), type: "image/svg+xml", name: "x.svg" }]) {
    const { status, json } = await send("POST", `/api/widgets/${widget._id}/image`, { files: [file] });
    assert.equal(status, 400);
    assert.match(json.message, /Only JPEG, PNG, WebP and GIF/);
  }
  assert.equal(filesOnDisk().length, 0);
});

test("a file over 5 MB -> 413 and nothing left on disk", async () => {
  const widget = makeWidget("image");
  const big = { data: Buffer.alloc(5 * 1024 * 1024 + 10), type: "image/png", name: "big.png" };
  assert.equal((await send("POST", `/api/widgets/${widget._id}/image`, { files: [big] })).status, 413);
  assert.equal(filesOnDisk().length, 0);
});

test("only ONE picture is accepted: extra files, or the wrong field name, are refused", async () => {
  const widget = makeWidget("image");
  const two = await send("POST", `/api/widgets/${widget._id}/image`, { files: [png(), png()] });
  assert.equal(two.status, 400);
  const wrongField = await send("POST", `/api/widgets/${widget._id}/image`, { files: [png()], field: "photos" });
  assert.equal(wrongField.status, 400);
  assert.equal((await send("POST", `/api/widgets/${widget._id}/image`, { files: [] })).status, 400);
  assert.equal(filesOnDisk().length, 0);
});

test("pictures only go into image widgets; the files are deleted on failure", async () => {
  const notes = makeWidget("notes");
  const { status, json } = await send("POST", `/api/widgets/${notes._id}/image`, { files: [png()] });
  assert.equal(status, 400);
  assert.match(json.message, /only be added to an image widget/);
  assert.equal(filesOnDisk().length, 0);
});

// ---- Access ---------------------------------------------------------------------------
test("a widget of a collection I am not part of is a 404, and uploaded files are deleted", async () => {
  const widget = makeWidget("image");
  allowedUsers.clear();
  assert.equal((await send("POST", `/api/widgets/${widget._id}/image`, { files: [png()] })).status, 404);
  assert.equal(filesOnDisk().length, 0);
  assert.equal((await send("GET", `/api/widgets/${widget._id}`)).status, 404);
  assert.equal((await send("DELETE", `/api/widgets/${widget._id}`)).status, 404);
  assert.ok(docs.has(String(widget._id))); // still there
});

test("a collaborator can edit the widgets of a shared collection", async () => {
  const widget = makeWidget("notes");
  const res = await send("PATCH", `/api/widgets/${widget._id}`, { json: { body: "Edited by a friend" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.widget.body, "Edited by a friend");
});

// ---- Notes: text AND checklist ------------------------------------------------------
test("a notes widget holds text and a checklist at the same time; edits keep item ids", async () => {
  const widget = makeWidget("notes", { checklist: [{ text: "one" }, { text: "two" }] });
  const keep = String(widget.checklist[0]._id);

  const { status, json } = await send("PATCH", `/api/widgets/${widget._id}`, {
    json: { body: "Hello", checklist: [{ id: keep, text: "one (edited)", done: true }, { text: "brand new" }] },
  });
  assert.equal(status, 200);
  assert.equal(json.widget.body, "Hello");
  assert.equal(json.widget.checklist[0].id, keep);
  assert.equal(json.widget.checklist[0].text, "one (edited)");
  assert.equal(json.widget.checklist[1].done, false);
  assert.equal(json.widget.mode, undefined);
  assert.equal(json.widget.checklistPercent, undefined); // no progress report
  assert.equal(json.collection.summary.tiles.find((t) => t.type === "note").text, "Hello");
});

test("changing only the text leaves the checklist alone, and the other way round", async () => {
  const widget = makeWidget("notes", { body: "text", checklist: [{ text: "item" }] });
  const url = `/api/widgets/${widget._id}`;
  assert.equal((await send("PATCH", url, { json: { body: "new text" } })).json.widget.checklist.length, 1);
  assert.equal((await send("PATCH", url, { json: { checklist: [] } })).json.widget.body, "new text");
});

test("toggling a checklist item flips it, or sets it explicitly", async () => {
  const widget = makeWidget("notes", { checklist: [{ text: "one" }] });
  const itemId = String(widget.checklist[0]._id);
  const url = `/api/widgets/${widget._id}/checklist/${itemId}`;

  assert.equal((await send("PATCH", url)).json.widget.checklist[0].done, true);
  assert.equal((await send("PATCH", url)).json.widget.checklist[0].done, false);
  assert.equal((await send("PATCH", url, { json: { done: true } })).json.widget.checklist[0].done, true);
  assert.equal((await send("PATCH", url, { json: { done: true } })).json.widget.checklist[0].done, true);

  assert.equal((await send("PATCH", `/api/widgets/${widget._id}/checklist/${new mongoose.Types.ObjectId()}`)).status, 404);
  const wrongType = makeWidget("date");
  assert.equal((await send("PATCH", `/api/widgets/${wrongType._id}/checklist/${itemId}`)).status, 400);
});

test("notes limits: 51 checklist items -> 400", async () => {
  const widget = makeWidget("notes");
  const checklist = Array.from({ length: 51 }, (_, i) => ({ text: `item ${i}` }));
  const { status, json } = await send("PATCH", `/api/widgets/${widget._id}`, { json: { checklist } });
  assert.equal(status, 400);
  assert.ok(json.fields.checklist);
});

// ---- Date --------------------------------------------------------------------------------
test("setting, rejecting and clearing a date", async () => {
  const widget = makeWidget("date");
  const url = `/api/widgets/${widget._id}`;

  const set = await send("PATCH", url, { json: { date: "2026-10-12", label: "Flight" } });
  assert.equal(set.json.widget.date, "2026-10-12");
  assert.equal(set.json.collection.summary.collectionDate, "2026-10-12");

  const bad = await send("PATCH", url, { json: { date: "2026-02-30" } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.date);

  const cleared = await send("PATCH", url, { json: { date: null } });
  assert.equal(cleared.json.widget.date, null);
  assert.equal(cleared.json.collection.summary.collectionDate, null);
});

test("with several date widgets, the collection date is the earliest", async () => {
  const early = makeWidget("date");
  const late = makeWidget("date");
  await send("PATCH", `/api/widgets/${late._id}`, { json: { date: "2026-12-01" } });
  const res = await send("PATCH", `/api/widgets/${early._id}`, { json: { date: "2026-10-05" } });
  assert.equal(res.json.collection.summary.collectionDate, "2026-10-05");
  assert.deepEqual(res.json.collection.summary.collectionDates, ["2026-10-05", "2026-12-01"]);
});

// ---- Unknown fields, wrong types, links ------------------------------------------------
test("field names must match the widget type", async () => {
  const widget = makeWidget("date");
  const { status, json } = await send("PATCH", `/api/widgets/${widget._id}`, { json: { body: "not for dates" } });
  assert.equal(status, 400);
  assert.ok(json.fields._);
});

test("an image widget cannot be PATCHed; its picture has its own endpoint", async () => {
  const widget = makeWidget("image");
  const { status, json } = await send("PATCH", `/api/widgets/${widget._id}`, { json: { image: null } });
  assert.equal(status, 400);
  assert.match(json.message, /\/image endpoint/);
});

test("clearing a link needs no network access", async () => {
  const widget = makeWidget("link", { url: "https://example.com/" });
  const { status, json } = await send("PATCH", `/api/widgets/${widget._id}`, { json: { url: "" } });
  assert.equal(status, 200);
  assert.equal(json.widget.url, null);
  assert.equal(json.widget.preview, null);
});

test("a private link address is refused when saving a link widget", async () => {
  const widget = makeWidget("link");
  const { status, json } = await send("PATCH", `/api/widgets/${widget._id}`, { json: { url: "http://127.0.0.1:3000" } });
  assert.equal(status, 400);
  assert.match(json.message, /private or local/);
});

// ---- Deleting widgets ---------------------------------------------------------------------
test("any kind of widget can be deleted; an image widget takes its picture with it", async () => {
  const image = makeWidget("image");
  await send("POST", `/api/widgets/${image._id}/image`, { files: [png()] });
  assert.equal(filesOnDisk().length, 1);

  const removed = await send("DELETE", `/api/widgets/${image._id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.deleted, { images: 1 });
  assert.equal(filesOnDisk().length, 0);
  assert.equal((await send("GET", `/api/widgets/${image._id}`)).status, 404);

  for (const type of ["notes", "date", "link"]) {
    const widget = makeWidget(type);
    const res = await send("DELETE", `/api/widgets/${widget._id}`);
    assert.equal(res.status, 200, type);
    assert.deepEqual(res.json.deleted, { images: 0 });
  }
});
