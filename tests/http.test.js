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
  for (const path of ["/api/events", "/api/events/search", `/api/widgets/${validId}`, "/api/friends", "/api/friends/requests"]) {
    const { status, json } = await call("GET", path, { auth: false });
    assert.equal(status, 401, path);
    assert.equal(json.message, "Not authenticated");
  }
});

test("malformed ids -> 400 before the database is touched", async () => {
  for (const [method, path] of [
    ["GET", "/api/events/not-an-id"],
    ["DELETE", "/api/events/123"],
    ["GET", "/api/widgets/xyz"],
    ["PATCH", `/api/widgets/${validId}/checklist/bad`],
    ["POST", "/api/events/xyz/rows"],
    ["PATCH", "/api/events/xyz/rows/order"],
    ["DELETE", "/api/widgets/xyz"],
    ["POST", "/api/events/xyz/collaborators"],
    ["DELETE", `/api/events/${validId}/collaborators/bad`],
    ["DELETE", "/api/friends/bad"],
    ["PATCH", "/api/friends/requests/bad/accept"],
  ]) {
    const { status, json } = await call(method, path, method === "GET" ? {} : { body: {} });
    assert.equal(status, 400, `${method} ${path}`);
    assert.match(json.message, /^Invalid /);
  }
});

test("creating an event with bad data -> 400 with per-field errors", async () => {
  const { status, json } = await call("POST", "/api/events", {
    body: { title: "", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"], widgets: { date: { date: "2026-10-12" } } },
  });
  assert.equal(status, 400);
  assert.equal(json.message, "Validation failed");
  assert.ok(json.fields.tags);
  // Events no longer start with widgets: they start with one empty row.
  assert.match(json.fields._[0], /Unrecognized key.*widgets/);
});

test("unknown fields are rejected, not silently ignored", async () => {
  const { status, json } = await call("POST", "/api/events", { body: { title: "Ok", owner: "someone-else" } });
  assert.equal(status, 400);
  assert.ok(json.fields._);
});

test("malformed JSON -> 400", async () => {
  const { status, json } = await call("POST", "/api/events", { rawBody: "{not json" });
  assert.equal(status, 400);
  assert.equal(json.message, "Request body is not valid JSON");
});

test("invalid search filters -> 400", async () => {
  const bad = await call("GET", "/api/events/search?status=nope");
  assert.equal(bad.status, 400);
  const range = await call("GET", "/api/events/search?dateFrom=2026-12-01&dateTo=2026-11-01");
  assert.equal(range.status, 400);
  assert.ok(range.json.fields.dateTo);
});

test("invalid status value -> 400", async () => {
  const { status } = await call("PATCH", `/api/events/${validId}/status`, { body: { status: "finished" } });
  assert.equal(status, 400);
});

test("an empty update -> 400", async () => {
  const { status, json } = await call("PATCH", `/api/events/${validId}`, { body: {} });
  assert.equal(status, 400);
  assert.ok(json.fields._);
});

test("reorder bodies are validated", async () => {
  assert.equal((await call("PATCH", `/api/events/${validId}/rows/order`, { body: {} })).status, 400);
  assert.equal((await call("PATCH", `/api/events/${validId}/rows/order`, { body: { order: ["nope"] } })).status, 400);
  assert.equal((await call("PATCH", `/api/events/${validId}/rows/${validId}/widgets/order`, { body: { order: [] } })).status, 400);
});

test("rows: names are limited and ids are checked", async () => {
  assert.equal((await call("PATCH", `/api/events/${validId}/rows/${validId}`, { body: {} })).status, 400);
  const long = await call("PATCH", `/api/events/${validId}/rows/${validId}`, { body: { name: "x".repeat(41) } });
  assert.equal(long.status, 400);
  assert.ok(long.json.fields.name);
  assert.equal((await call("POST", `/api/events/${validId}/rows`, { body: { name: "x".repeat(41) } })).status, 400);
  assert.equal((await call("POST", `/api/events/${validId}/rows`, { body: { colour: "red" } })).status, 400);
  assert.equal((await call("PATCH", "/api/events/bad/rows/order", { body: { order: [validId] } })).status, 400);
  assert.equal((await call("DELETE", `/api/events/${validId}/rows/bad`)).status, 400);
});

test("adding a widget needs a known type and matching content", async () => {
  const url = `/api/events/${validId}/rows/${validId}/widgets`;
  for (const body of [{}, { type: "poem" }, { type: "image", url: "https://example.com" }, { type: "link", url: "nope" }, { type: "date", date: "2026-02-30" }, { type: "notes", body: 5 }]) {
    const { status, json } = await call("POST", url, { body });
    assert.equal(status, 400, JSON.stringify(body));
    assert.ok(json.fields, JSON.stringify(body));
  }
  assert.equal((await call("POST", `/api/events/${validId}/rows/bad/widgets`, { body: { type: "notes" } })).status, 400);
});

test("sharing bodies are validated before anything else", async () => {
  assert.equal((await call("POST", `/api/events/${validId}/collaborators`, { body: {} })).status, 400);
  assert.equal((await call("POST", `/api/events/${validId}/collaborators`, { body: { userId: "nope" } })).status, 400);
  const create = await call("POST", "/api/events", { body: { title: "T", collaborators: ["nope"] } });
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
  assert.equal((await call("GET", "/api/events/search?scope=everyone")).status, 400);
});

test("the stats endpoint no longer exists", async () => {
  // "stats" is now read as an event id, which is not a valid one.
  const { status } = await call("GET", "/api/events/stats");
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
    const { status, json } = await call("GET", "/api/events"); // no database -> throws
    assert.equal(status, 500);
    assert.deepEqual(json, { message: "Internal server error" });
  } finally {
    console.error = original;
  }
});
