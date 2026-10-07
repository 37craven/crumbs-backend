const test = require("node:test");
const assert = require("node:assert/strict");
const { checkTransition } = require("../services/collectionStatus");

const collection = (status, summary = {}) => ({ status, summary });

test("allowed moves return null", () => {
  assert.equal(checkTransition(collection("draft", { collectionDate: "2026-10-12" }), "planned"), null);
  assert.equal(checkTransition(collection("planned"), "draft"), null);
  assert.equal(checkTransition(collection("planned"), "archived"), null);
  assert.equal(checkTransition(collection("archived"), "draft"), null);
});

test("moves outside the diagram are refused", () => {
  assert.match(checkTransition(collection("draft"), "done"), /cannot move/);
  assert.match(checkTransition(collection("archived"), "planned"), /cannot move/);
  assert.match(checkTransition(collection("done"), "draft"), /cannot move/);
});

test("moving to the same status is refused", () => {
  assert.match(checkTransition(collection("draft"), "draft"), /already draft/);
});

test("planning needs a date", () => {
  assert.match(checkTransition(collection("draft", { collectionDate: null }), "planned"), /Add a date/);
  assert.equal(checkTransition(collection("draft", { collectionDate: "2026-10-12" }), "planned"), null);
});

test("finishing needs every checklist item ticked", () => {
  const one = checkTransition(collection("planned", { openChecklistItems: 1 }), "done");
  assert.match(one, /1 item is still open/);
  const three = checkTransition(collection("planned", { openChecklistItems: 3 }), "done");
  assert.match(three, /3 items are still open/);
  assert.equal(checkTransition(collection("planned", { openChecklistItems: 0 }), "done"), null);
});

test("a collection with no checklist in use can be finished", () => {
  assert.equal(checkTransition(collection("planned", {}), "done"), null);
});
