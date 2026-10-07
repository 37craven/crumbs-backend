const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Collection = require("../models/Collection");
const { Widget } = require("../models/Widget");
const { buildTiles } = require("../services/collectionTiles");
const { serializeCollection } = require("../services/serializers");
const { checkTransition } = require("../services/collectionStatus");
const { refreshCollectionSummary } = require("../services/collectionSummary");
const { createCollectionSchema } = require("../validators/collection");
const { parseOrThrow } = require("../validators/common");

const types = (tiles) => tiles.map((t) => t.type).join();
const urls = (n) => Array.from({ length: n }, (_, i) => `/u/${i}.png`);

test("the card has four tiles: date, note, image, link", () => {
  const tiles = buildTiles({ collectionDates: ["2026-01-02"], noteExcerpts: ["hi"], imageUrls: urls(3), links: [{ url: "https://a.test" }] });
  assert.equal(types(tiles), "date,note,image,link");
});

test("a missing link slot is filled by more pictures", () => {
  assert.equal(types(buildTiles({ collectionDates: ["2026-01-02"], noteExcerpts: ["hi"], imageUrls: urls(13) })), "date,note,image,image");
});

test("other kinds can fill free slots too, and there are never more than four", () => {
  assert.equal(types(buildTiles({ links: [{ url: "1" }, { url: "2" }, { url: "3" }, { url: "4" }, { url: "5" }] })), "link,link,link,link");
  assert.equal(types(buildTiles({ imageUrls: urls(2), links: [{ url: "1" }, { url: "2" }] })), "image,image,link,link");
  assert.equal(types(buildTiles({ collectionDates: ["a", "b", "c", "d", "e"], noteExcerpts: ["x"], imageUrls: urls(9), links: [{ url: "1" }] })).split(",").length, 4);
  assert.deepEqual(buildTiles({}), []);
});

test("a collection reports how many memories it holds and which statuses come next", () => {
  const e = (status, imageCount) => serializeCollection({ _id: "e", title: "T", status, owner: "u", summary: { imageCount } }, { today: "2026-10-02" });
  assert.equal(e("draft", 13).summary.imageCount, 13);
  assert.deepEqual(e("draft").nextStatuses, ["planned", "archived"]); // no "done" from a draft
  assert.deepEqual(e("archived").nextStatuses, ["draft"]); // no "planned" or "done" when archived
  assert.deepEqual(e("planned").nextStatuses, ["draft", "done", "archived"]);
  assert.deepEqual(e("done").nextStatuses, ["planned", "archived"]);
  assert.deepEqual(e("new").nextStatuses, []);
});

test("a blank new collection cannot be moved by hand", () => {
  assert.match(checkTransition({ status: "new" }, "planned"), /cannot move/);
});

test("a collection can be opened with no title; editing later still needs one", async () => {
  assert.equal(parseOrThrow(createCollectionSchema, {}).title, "");
  assert.equal(parseOrThrow(createCollectionSchema, { title: "" }).title, "");
  await new Collection({ owner: new mongoose.Types.ObjectId(), status: "new", rows: [{ name: "" }] }).validate();
});

// ---- refreshCollectionSummary turns a "new" collection into a draft once it has content ----
const lean = (value) => ({ lean: async () => value });
function stub(collection, widgets) {
  Collection.findById = () => lean(collection);
  Widget.find = () => lean(widgets);
  Collection.findByIdAndUpdate = (id, update) => lean({ ...collection, ...update.$set });
}
const blank = { _id: "e", owner: "u", title: "", description: "", tags: [], status: "new", rows: [] };

test("a new collection stays new while nothing has been added", async () => {
  stub(blank, []);
  assert.equal((await refreshCollectionSummary("e")).status, "new");
});

test("a new collection becomes a draft when a title, a tag or a widget is added", async () => {
  stub({ ...blank, title: "Japan trip" }, []);
  assert.equal((await refreshCollectionSummary("e")).status, "draft");
  stub({ ...blank, tags: ["travel"] }, []);
  assert.equal((await refreshCollectionSummary("e")).status, "draft");
  stub(blank, [{ type: "notes", row: "r", order: 0, body: "", checklist: [] }]);
  assert.equal((await refreshCollectionSummary("e")).status, "draft");
});

test("collections that are not new keep their status", async () => {
  stub({ ...blank, title: "T", status: "planned" }, []);
  assert.equal((await refreshCollectionSummary("e")).status, "planned");
});

test("a date tile says how far away its date is", () => {
  const summary = { collectionDates: ["2026-10-04", "2026-10-09"], imageUrls: ["/u/a.png"] };
  const json = serializeCollection({ _id: "e", title: "T", status: "draft", owner: "u", summary }, { today: "2026-10-04" });
  assert.deepEqual(json.summary.tiles[0], { type: "date", date: "2026-10-04", dateStatus: "today", daysUntil: 0 });
  assert.equal(json.summary.tiles.find((t) => t.type === "image").dateStatus, undefined);
});
