const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSummary } = require("../services/eventSummary");
const { serializeEvent, serializeWidget, sortWidgets } = require("../services/serializers");

const rows = [{ _id: "r1", name: "Plans" }, { _id: "r2", name: "" }];
const event = { _id: "e1", title: "Beach Trip", description: "Sunny", tags: ["travel"], rows };

const notes = (row, order, fields) => ({ type: "notes", row, order, body: "", checklist: [], ...fields });
const date = (row, order, d, label = "") => ({ type: "date", row, order, date: d, label });
const image = (row, order, name) => ({ type: "image", row, order, image: name ? { url: `/uploads/${name}`, originalName: name } : null });
const link = (row, order, url, title) => ({ type: "link", row, order, url, preview: url ? { title, siteName: "Site", image: "https://x.test/og.png" } : null });

test("an event with no widgets has an empty summary", () => {
  const { summary } = buildSummary(event, []);
  assert.equal(summary.eventDate, null);
  assert.deepEqual(summary.eventDates, []);
  assert.equal(summary.imageCount, 0);
  assert.deepEqual(summary.imageUrls, []);
  assert.deepEqual(summary.links, []);
  assert.deepEqual(summary.noteExcerpts, []);
});

test("the event date is the EARLIEST date widget; all dates are kept for range search", () => {
  const { summary } = buildSummary(event, [date("r1", 0, "2026-10-20"), date("r2", 0, "2026-10-05"), date("r1", 1, null), date("r1", 2, "2026-11-01")]);
  assert.equal(summary.eventDate, "2026-10-05");
  assert.deepEqual(summary.eventDates, ["2026-10-05", "2026-10-20", "2026-11-01"]);
});

test("notes hold text AND a checklist; open items are counted across ALL notes widgets", () => {
  const { summary } = buildSummary(event, [
    notes("r1", 0, { body: "Bring sunscreen", checklist: [{ _id: "c1", text: "Book hotel", done: true }, { _id: "c2", text: "Pack bags", done: false }] }),
    notes("r2", 0, { checklist: [{ _id: "c3", text: "Buy tickets", done: false }] }),
  ]);
  assert.deepEqual(summary.noteExcerpts, ["Bring sunscreen", "Buy tickets"]);
  assert.equal(summary.openChecklistItems, 2);
});

test("with no text anywhere, the preview falls back to the first checklist", () => {
  const { summary } = buildSummary(event, [notes("r1", 0, { checklist: [{ _id: "a", text: "one" }, { _id: "b", text: "two" }] })]);
  assert.deepEqual(summary.noteExcerpts, ["one · two"]);
});

test("the cover is the first picture in display order (rows top to bottom, then left to right)", () => {
  const { summary } = buildSummary(event, [image("r2", 0, "bottom.png"), image("r1", 1, "second.png"), image("r1", 0, "first.png"), image("r1", 2, null)]);
  assert.deepEqual(summary.imageUrls, ["/uploads/first.png", "/uploads/second.png", "/uploads/bottom.png"]);
  assert.equal(summary.imageCount, 3); // the empty image widget is not counted
});

test("links are counted across all rows; empty ones are ignored", () => {
  const { summary } = buildSummary(event, [link("r1", 0, null), link("r2", 0, "https://two.test/", "Two"), link("r1", 1, "https://one.test/", "One")]);
  assert.equal(summary.linkCount, 2);
  assert.equal(summary.links[0].url, "https://one.test/"); // first in display order
  assert.equal(summary.links[0].title, "One");
});

test("searchText covers row names, notes, checklist, date labels, links and picture names", () => {
  const { searchText } = buildSummary(event, [
    notes("r1", 0, { body: "Bring sunscreen", checklist: [{ _id: "c", text: "Book hotel" }] }),
    date("r1", 1, "2026-10-12", "Flight"), link("r2", 0, "https://one.test/", "First Page"), image("r2", 1, "sunset.png"),
  ]);
  for (const word of ["beach trip", "travel", "plans", "sunscreen", "book hotel", "flight", "first page", "sunset.png"]) {
    assert.ok(searchText.includes(word), `missing "${word}"`);
  }
  assert.equal(searchText, searchText.toLowerCase());
});

// ---- serializers ------------------------------------------------------------
const people = new Map([["u1", { id: "u1", username: "jian" }], ["u2", { id: "u2", username: "mika" }]]);
const stored = (extra = {}) => ({ _id: "e1", title: "T", status: "planned", owner: "u1", collaborators: ["u2"], rows, summary: { eventDate: "2026-10-05" }, ...extra });

test("serializeEvent works out date info at read time", () => {
  const soon = serializeEvent(stored(), { today: "2026-10-02" });
  assert.equal(soon.summary.daysUntil, 3);
  assert.equal(soon.summary.dateStatus, "upcoming");
  assert.equal(soon.isOverdue, false);

  const later = serializeEvent(stored(), { today: "2026-10-09" });
  assert.equal(later.summary.daysUntil, -4);
  assert.equal(later.isOverdue, true);
  assert.equal(serializeEvent(stored({ status: "done" }), { today: "2026-10-09" }).isOverdue, false);
});

test("serializeEvent lists rows, people and the viewer's role", () => {
  const json = serializeEvent(stored(), { today: "2026-10-02", viewerId: "u2", people });
  assert.deepEqual(json.rows, [{ id: "r1", name: "Plans" }, { id: "r2", name: "" }]);
  assert.deepEqual(json.owner, { id: "u1", username: "jian" });
  assert.deepEqual(json.collaborators, [{ id: "u2", username: "mika" }]);
  assert.equal(json.role, "collaborator");
  assert.equal(serializeEvent(stored(), { viewerId: "u1", people }).role, "owner");
});

test("serializeEvent hides internals and has no thumbnail or checklist progress", () => {
  const json = serializeEvent(stored({ searchText: "x", summary: { openChecklistItems: 2, imageCount: 13, imageUrls: ["/uploads/a.png"] } }), { today: "2026-10-02" });
  assert.equal(json.searchText, undefined);
  assert.equal(json.summary.openChecklistItems, undefined);
  assert.equal(json.summary.imageCount, 13); // "13 memories"
  assert.deepEqual(json.summary.tiles, [{ type: "image", url: "/uploads/a.png" }]);
});

test("serializeWidget: image widgets hold one picture and hide the file name", () => {
  const json = serializeWidget({ ...image("r1", 0, "a.png"), _id: "w1", event: "e1", row: "r1" });
  assert.equal(json.rowId, "r1");
  assert.equal(json.image.url, "/uploads/a.png");
  assert.equal(json.image.filename, undefined);
  assert.equal(json.thumbnailId, undefined);
  assert.equal(serializeWidget({ ...image("r1", 0, null), _id: "w2", event: "e1", row: "r1" }).image, null);
});

test("serializeWidget: notes carry both text and checklist; dates carry a countdown", () => {
  const n = serializeWidget({ ...notes("r1", 0, { body: "hi", checklist: [{ _id: "c1", text: "x", done: true }] }), _id: "w1", event: "e1" });
  assert.equal(n.body, "hi");
  assert.deepEqual(n.checklist, [{ id: "c1", text: "x", done: true }]);
  assert.equal(n.mode, undefined);
  assert.equal(n.checklistPercent, undefined);
  assert.equal(serializeWidget({ ...date("r1", 0, "2026-10-12"), _id: "w3", event: "e1" }, "2026-10-02").daysUntil, 10);
});

test("sortWidgets: rows top to bottom (as listed in the event), then left to right", () => {
  const sorted = sortWidgets([
    { _id: "d", row: "r2", order: 0 }, { _id: "b", row: "r1", order: 1 }, { _id: "c", row: "r2", order: 1 }, { _id: "a", row: "r1", order: 0 },
  ], event);
  assert.deepEqual(sorted.map((w) => w._id), ["a", "b", "d", "c"]);
  // reordering the rows reorders the result
  const flipped = sortWidgets(sorted, { rows: [rows[1], rows[0]] });
  assert.deepEqual(flipped.map((w) => w._id), ["d", "c", "a", "b"]);
});

test("a date can be found by its month name, a short form of it, or its year", () => {
  const { searchText } = buildSummary(event, [date("r1", 0, "2026-12-25", "Christmas")]);
  for (const word of ["december", "dec", "2026", "2026-12-25", "christmas"]) assert.ok(searchText.includes(word), word);
  assert.ok(!searchText.includes("november"));
});

test("title and tags are searchable text too", () => {
  const { searchText } = buildSummary({ ...event, title: "Japan trip", tags: ["travel", "december"] }, []);
  assert.ok(searchText.includes("travel") && searchText.includes("japan") && searchText.includes("december"));
});
