const test = require("node:test");
const assert = require("node:assert/strict");
const { checkTransition } = require("../services/eventStatus");

const event = (status, summary = {}) => ({ status, summary });

test("allowed moves return null", () => {
  assert.equal(checkTransition(event("draft", { eventDate: "2026-10-12" }), "planned"), null);
  assert.equal(checkTransition(event("planned"), "draft"), null);
  assert.equal(checkTransition(event("planned"), "archived"), null);
  assert.equal(checkTransition(event("archived"), "draft"), null);
});

test("moves outside the diagram are refused", () => {
  assert.match(checkTransition(event("draft"), "done"), /cannot move/);
  assert.match(checkTransition(event("archived"), "planned"), /cannot move/);
  assert.match(checkTransition(event("done"), "draft"), /cannot move/);
});

test("moving to the same status is refused", () => {
  assert.match(checkTransition(event("draft"), "draft"), /already draft/);
});

test("planning needs a date", () => {
  assert.match(checkTransition(event("draft", { eventDate: null }), "planned"), /Add a date/);
  assert.equal(checkTransition(event("draft", { eventDate: "2026-10-12" }), "planned"), null);
});

test("finishing needs every checklist item ticked", () => {
  const one = checkTransition(event("planned", { openChecklistItems: 1 }), "done");
  assert.match(one, /1 item is still open/);
  const three = checkTransition(event("planned", { openChecklistItems: 3 }), "done");
  assert.match(three, /3 items are still open/);
  assert.equal(checkTransition(event("planned", { openChecklistItems: 0 }), "done"), null);
});

test("an event with no checklist in use can be finished", () => {
  assert.equal(checkTransition(event("planned", {}), "done"), null);
});
