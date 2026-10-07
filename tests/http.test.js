// End-to-end checks through the real Express app. There is no database here,
// so these only cover requests that are answered BEFORE any query runs:
// authentication, id checks, body validation, 404s and the error format.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false); // fail fast instead of waiting for a database

const User = require("../models/User");
const app = require("../app");

const userId = new mongoose.Types.ObjectId().toString();
// Pretend the logged-in user exists, without a database.
User.findById = async () => ({ _id: userId, toPublic: () => ({ id: userId }) });

const cookie = `crumbs_token=${jwt.sign({ sub: userId }, process.env.JWT_SECRET)}`;
const validId = new mongoose.Types.ObjectId().toString();

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, path, { body, rawBody, auth = true } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth && { Cookie: cookie }),
      ...((body || rawBody) && { "Content-Type": "application/json" }),
    },
    body: rawBody ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

test("unknown route -> 404 JSON", async () => {
  const { status, json } = await call("GET", "/api/nothing-here", { auth: false });
  assert.equal(status, 404);
  assert.match(json.message, /Route not found: GET \/api\/nothing-here/);
});

test("no cookie -> 401", async () => {
  for (const path of ["/api/collections", "/api/collections/search", `/api/widgets/${validId}`, "/api/friends", "/api/friends/requests", "/api/crumbs"]) {
    const { status, json } = await call("GET", path, { auth: false });
    assert.equal(status, 401, path);
    assert.equal(json.message, "Not authenticated");
  }
});

test("malformed ids -> 400 before the database is touched", async () => {
  for (const [method, path] of [
    ["GET", "/api/collections/not-an-id"],
    ["DELETE", "/api/collections/123"],
    ["GET", "/api/widgets/xyz"],
    ["PATCH", `/api/widgets/${validId}/checklist/bad`],
    ["POST", "/api/collections/xyz/rows"],
    ["PATCH", "/api/collections/xyz/rows/order"],
    ["DELETE", "/api/widgets/xyz"],
    ["POST", "/api/collections/xyz/collaborators"],
    ["DELETE", `/api/collections/${validId}/collaborators/bad`],
    ["DELETE", "/api/friends/bad"],
    ["PATCH", "/api/friends/requests/bad/accept"],
    ["DELETE", "/api/crumbs/bad"],
  ]) {
    const { status, json } = await call(method, path, method === "GET" ? {} : { body: {} });
    assert.equal(status, 400, `${method} ${path}`);
    assert.match(json.message, /^Invalid /);
  }
});

test("creating a collection with bad data -> 400 with per-field errors", async () => {
  const { status, json } = await call("POST", "/api/collections", {
    body: { title: "", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], widgets: { date: { date: "2026-10-12" } } },
  });
  assert.equal(status, 400);
  assert.equal(json.message, "Validation failed");
  assert.ok(json.fields.tags);
  // Collections no longer start with widgets: they start with one empty row.
  assert.match(json.fields._[0], /Unrecognized key.*widgets/);
});

test("unknown fields are rejected, not silently ignored", async () => {
  const { status, json } = await call("POST", "/api/collections", { body: { title: "Ok", owner: "someone-else" } });
  assert.equal(status, 400);
  assert.ok(json.fields._);
});

test("malformed JSON -> 400", async () => {
  const { status, json } = await call("POST", "/api/collections", { rawBody: "{not json" });
  assert.equal(status, 400);
  assert.equal(json.message, "Request body is not valid JSON");
});

test("invalid search filters -> 400", async () => {
  const bad = await call("GET", "/api/collections/search?status=nope");
  assert.equal(bad.status, 400);
  const range = await call("GET", "/api/collections/search?dateFrom=2026-12-01&dateTo=2026-11-01");
  assert.equal(range.status, 400);
  assert.ok(range.json.fields.dateTo);
});

test("invalid status value -> 400", async () => {
  const { status } = await call("PATCH", `/api/collections/${validId}/status`, { body: { status: "finished" } });
  assert.equal(status, 400);
});

test("an empty update -> 400", async () => {
  const { status, json } = await call("PATCH", `/api/collections/${validId}`, { body: {} });
  assert.equal(status, 400);
  assert.ok(json.fields._);
});

test("reorder bodies are validated", async () => {
  assert.equal((await call("PATCH", `/api/collections/${validId}/rows/order`, { body: {} })).status, 400);
  assert.equal((await call("PATCH", `/api/collections/${validId}/rows/order`, { body: { order: ["nope"] } })).status, 400);
  assert.equal((await call("PATCH", `/api/collections/${validId}/rows/${validId}/widgets/order`, { body: { order: [] } })).status, 400);
});

test("rows: names are limited and ids are checked", async () => {
  assert.equal((await call("PATCH", `/api/collections/${validId}/rows/${validId}`, { body: {} })).status, 400);
  const long = await call("PATCH", `/api/collections/${validId}/rows/${validId}`, { body: { name: "x".repeat(41) } });
  assert.equal(long.status, 400);
  assert.ok(long.json.fields.name);
  assert.equal((await call("POST", `/api/collections/${validId}/rows`, { body: { name: "x".repeat(41) } })).status, 400);
  assert.equal((await call("POST", `/api/collections/${validId}/rows`, { body: { colour: "red" } })).status, 400);
  assert.equal((await call("PATCH", "/api/collections/bad/rows/order", { body: { order: [validId] } })).status, 400);
  assert.equal((await call("DELETE", `/api/collections/${validId}/rows/bad`)).status, 400);
});

test("adding a widget needs a known type and matching content", async () => {
  const url = `/api/collections/${validId}/rows/${validId}/widgets`;
  for (const body of [{}, { type: "poem" }, { type: "image", url: "https://example.com" }, { type: "link", url: "nope" }, { type: "date", date: "2026-02-30" }, { type: "notes", body: 5 }]) {
    const { status, json } = await call("POST", url, { body });
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(json.fields, JSON.stringify(body));
  }
  assert.equal((await call("POST", `/api/collections/${validId}/rows/bad/widgets`, { body: { type: "notes" } })).status, 400);
});

test("sharing bodies are validated before anything else", async () => {
  assert.equal((await call("POST", `/api/collections/${validId}/collaborators`, { body: {} })).status, 400);
  assert.equal((await call("POST", `/api/collections/${validId}/collaborators`, { body: { userId: "nope" } })).status, 400);
  const create = await call("POST", "/api/collections", { body: { title: "T", collaborators: ["nope"] } });
  assert.equal(create.status, 400);
  assert.ok(create.json.fields["collaborators.0"]);
});

test("friend requests and user search are validated", async () => {
  assert.equal((await call("POST", "/api/friends/requests", { body: {} })).status, 400);
  const short = await call("GET", "/api/friends/search?q=a");
  assert.equal(short.status, 400);
  assert.deepEqual(short.json.fields.q, ["Type at least 2 characters"]);
  assert.equal((await call("GET", "/api/friends/search")).status, 400);
});

test("search scope must be a known value", async () => {
  assert.equal((await call("GET", "/api/collections/search?scope=everyone")).status, 400);
});

test("the stats endpoint no longer exists", async () => {
  // "stats" is now read as a collection id, which is not a valid one.
  const { status } = await call("GET", "/api/collections/stats");
  assert.equal(status, 400);
});

test("link preview refuses private addresses", async () => {
  for (const url of ["http://127.0.0.1:3000/health", "http://localhost/", "http://169.254.169.254/latest/meta-data"]) {
    const { status, json } = await call("POST", "/api/links/preview", { body: { url } });
    assert.equal(status, 400, url);
    assert.match(json.message, /private or local/);
  }
  const missing = await call("POST", "/api/links/preview", { body: {} });
  assert.equal(missing.status, 400);
});

test("a server-side failure -> 500 with a generic message", async () => {
  const original = console.error;
  console.error = () => {}; // the handler logs the real error; keep test output clean
  try {
    const { status, json } = await call("GET", "/api/collections"); // no database -> throws
    assert.equal(status, 500);
    assert.deepEqual(json, { message: "Internal server error" });
  } finally {
    console.error = original;
  }
});
