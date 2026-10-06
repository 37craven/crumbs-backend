const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSearchFilter, buildSortStages, escapeRegex } = require("../services/eventSearch");
const { searchQuerySchema } = require("../validators/search");
const { parseOrThrow } = require("../validators/common");

const owner = "owner-id";
const parse = (input) => parseOrThrow(searchQuerySchema, input);

test("by default a search covers events I created and events shared with me", () => {
  const filter = buildSearchFilter(parse({}), owner);
  assert.deepEqual(filter.$and, [{ $or: [{ owner }, { collaborators: owner }] }]);
});

test("scope narrows the search to my own or to shared events", () => {
  assert.deepEqual(buildSearchFilter(parse({ scope: "mine" }), owner).$and[0], { owner });
  assert.deepEqual(buildSearchFilter(parse({ scope: "shared" }), owner).$and[0], { collaborators: owner });
  assert.throws(() => parse({ scope: "everyone" }), (e) => e.status === 400);
});

test("each search word becomes its own condition", () => {
  const filter = buildSearchFilter(parse({ q: "trip  budget" }), owner);
  assert.equal(filter.$and.length, 3); // scope + 2 words
  assert.equal(filter.$and[1].searchText.$regex, "trip");
  assert.equal(filter.$and[2].searchText.$regex, "budget");
});

test("regex characters in the search box are escaped", () => {
  assert.equal(escapeRegex("a.b*c(d)"), "a\\.b\\*c\\(d\\)");
  const filter = buildSearchFilter(parse({ q: ".*" }), owner);
  assert.equal(filter.$and[1].searchText.$regex, "\\.\\*");
});

test("filters combine with AND", () => {
  const query = parse({ status: "planned,done", tags: "school,work", has: "image,date", dateFrom: "2026-10-01", dateTo: "2026-10-31" });
  const filter = buildSearchFilter(query, owner);
  assert.deepEqual(filter.$and[1], { status: { $in: ["planned", "done"] } });
  assert.deepEqual(filter.$and[2], { tags: { $all: ["school", "work"] } });
  assert.deepEqual(filter.$and[3], { "summary.imageCount": { $gt: 0 } });
  assert.deepEqual(filter.$and[4], { "summary.eventDate": { $ne: null } });
  // Several dates per event: ANY of them may fall in the range, inside ONE element.
  assert.deepEqual(filter.$and[5], { "summary.eventDates": { $elemMatch: { $gte: "2026-10-01", $lte: "2026-10-31" } } });
  assert.equal(filter.$and.length, 6);
});

test("a one-sided date range matches any date on that side", () => {
  const from = buildSearchFilter(parse({ dateFrom: "2026-10-01" }), owner).$and[1];
  const to = buildSearchFilter(parse({ dateTo: "2026-10-31" }), owner).$and[1];
  assert.deepEqual(from, { "summary.eventDates": { $gte: "2026-10-01" } });
  assert.deepEqual(to, { "summary.eventDates": { $lte: "2026-10-31" } });
});

test("sorting by date puts events without a date last, both directions", () => {
  for (const sort of ["date_asc", "date_desc"]) {
    const stages = buildSortStages(sort);
    assert.equal(stages[1].$sort.noDate, 1); // noDate sorts first, so dated events lead
  }
  assert.equal(buildSortStages("date_asc")[1].$sort["summary.eventDate"], 1);
  assert.equal(buildSortStages("date_desc")[1].$sort["summary.eventDate"], -1);
});

test("title sort ignores letter case", () => {
  const stages = buildSortStages("title");
  assert.deepEqual(stages[0].$addFields.titleKey, { $toLower: "$title" });
});

test("bad queries are rejected with field errors", () => {
  assert.throws(() => parse({ status: "nope" }), (e) => e.status === 400);
  assert.throws(() => parse({ limit: "500" }), (e) => e.status === 400);
  assert.throws(() => parse({ page: "0" }), (e) => e.status === 400);
  assert.throws(() => parse({ sort: "random" }), (e) => e.status === 400);
  assert.throws(
    () => parse({ dateFrom: "2026-12-01", dateTo: "2026-11-01" }),
    (e) => e.status === 400 && Boolean(e.fields.dateTo),
  );
});

test("defaults", () => {
  const query = parse({});
  assert.equal(query.sort, "recent");
  assert.equal(query.page, 1);
  assert.equal(query.limit, 12);
  assert.deepEqual(query.status, []);
});
