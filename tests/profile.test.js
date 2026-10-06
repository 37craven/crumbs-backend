// Exercises the profile routes against real files on disk and real Mongoose
// documents. Only the database calls are replaced with in-memory stand-ins.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "crumbs-profile-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const User = require("../models/User");
const Friendship = require("../models/Friendship");
const app = require("../app");

const userId = new mongoose.Types.ObjectId();
const otherId = new mongoose.Types.ObjectId();
const PASSWORD = "correct horse battery";
const OTHER_HASH = bcrypt.hashSync("someone-elses-password", 10);

// ---- In-memory stand-ins for the database -----------------------------------
let user;          // the signed-in user document
let takenAccounts; // other accounts whose email/username are already in use
let friendCount = 0;
let saved = {};   // what the password route last wrote

function makeUser(overrides = {}) {
  const doc = new User({
    _id: userId,
    username: "mika",
    usernameLower: "mika",
    email: "mika@example.com",
    firstName: "",
    lastName: "",
    password: OTHER_HASH,
    ...overrides,
  });
  doc.save = async function save() {
    await this.validate();
    return this;
  };
  return doc;
}

// requireAuth awaits the plain document; the password route chains .select() to
// ask for the hidden password field. One stub serves both.
User.findById = (id) => {
  const found = String(id) === String(userId) ? user : null;

  // The password route saves the document it is handed, so hand back a real
  // User document with the normally-hidden password field carried over.
  const withPassword = () => {
    if (!found) return null;
    const doc = new User({ ...found.toObject(), password: found.password });
    doc.save = async function save() {
      await this.validate();
      // Record what was written so the test can check the new hash.
      saved.password = this.password;
      return this;
    };
    return doc;
  };

  const query = {
    select: async (fields) =>
      String(fields).includes("+password") ? withPassword() : found,
    then: (resolve) => Promise.resolve(resolve(found)),
  };
  return query;
};
User.find = (filter) => {
  const email = filter.$or?.find((c) => c.email)?.email;
  const lower = filter.$or?.find((c) => c.usernameLower)?.usernameLower;
  const rows = takenAccounts.filter(
    (a) => a.email === email || a.usernameLower === lower,
  );
  return { select: () => ({ lean: async () => rows }) };
};

// getFriendIds() counts accepted friendships. Stub the query it runs, not the
// exported function: routes/auth.js destructures that at require time.
Friendship.find = () => ({
  lean: async () =>
    Array.from({ length: friendCount }, () => ({
      requester: userId,
      recipient: otherId,
      status: "accepted",
    })),
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
  user = makeUser();
  takenAccounts = [];
  friendCount = 0;
  saved = {};
  for (const f of fs.readdirSync(process.env.UPLOAD_DIR)) {
    fs.unlinkSync(path.join(process.env.UPLOAD_DIR, f));
  }
});

const filesOnDisk = () => fs.readdirSync(process.env.UPLOAD_DIR);

async function send(method, url, { json, files, auth = true } = {}) {
  const headers = auth ? { Cookie: cookie } : {};
  // GET and DELETE take no body, and fetch refuses to send one.
  const withBody = method !== "GET" && method !== "DELETE";
  let body;
  if (withBody && files) {
    body = new FormData();
    for (const f of files) {
      body.append("image", new Blob([f.data], { type: f.type }), f.name);
    }
  } else if (withBody && json) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(base + url, { method, headers, body });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const png = (name = "a.png") => ({ data: PNG, type: "image/png", name });
const profile = (overrides = {}) => ({
  firstName: "",
  lastName: "",
  username: "mika",
  email: "mika@example.com",
  ...overrides,
});

// ---- /me ---------------------------------------------------------------------
test("GET /me returns the user with a friend count and no password", async () => {
  friendCount = 3;

  const { status, json } = await send("GET", "/api/auth/me");
  assert.equal(status, 200);
  assert.equal(json.user.id, String(userId));
  assert.equal(json.user.email, "mika@example.com");
  assert.equal(json.user.friendsCount, 3);
  assert.equal(json.user.password, undefined);
  assert.equal(json.user.avatarUrl, null);
});

test("GET /me without a cookie -> 401", async () => {
  const { status } = await send("GET", "/api/auth/me", { auth: false });
  assert.equal(status, 401);
});

// ---- PATCH /me ---------------------------------------------------------------
test("names are saved, and the whole profile is returned", async () => {
  const { status, json } = await send("PATCH", "/api/auth/me", {
    json: profile({ firstName: "Mika", lastName: "Santos" }),
  });

  assert.equal(status, 200);
  assert.equal(json.user.firstName, "Mika");
  assert.equal(json.user.lastName, "Santos");
  assert.equal(user.usernameLower, "mika"); // still in sync
});

test("a name over 50 characters -> 400 naming the field", async () => {
  const { status, json } = await send("PATCH", "/api/auth/me", {
    json: profile({ firstName: "x".repeat(51) }),
  });

  assert.equal(status, 400);
  assert.match(json.fields.firstName[0], /50/);
  assert.equal(user.firstName, ""); // unchanged
});

test("an invalid username or email -> 400", async () => {
  const badName = await send("PATCH", "/api/auth/me", {
    json: profile({ username: "no spaces allowed" }),
  });
  assert.equal(badName.status, 400);
  assert.ok(badName.json.fields.username);

  const badEmail = await send("PATCH", "/api/auth/me", {
    json: profile({ email: "not-an-email" }),
  });
  assert.equal(badEmail.status, 400);
  assert.ok(badEmail.json.fields.email);
});

test("an email another account already has -> 409 naming the field", async () => {
  takenAccounts = [{ email: "taken@example.com", usernameLower: "someone" }];

  const { status, json } = await send("PATCH", "/api/auth/me", {
    json: profile({ email: "taken@example.com" }),
  });

  assert.equal(status, 409);
  assert.match(json.fields.email[0], /already exists/);
  assert.equal(user.email, "mika@example.com");
});

test("a username another account already has -> 409 naming the field", async () => {
  takenAccounts = [{ email: "other@example.com", usernameLower: "mika" }];

  const { status, json } = await send("PATCH", "/api/auth/me", {
    json: profile({ username: "Mika" }), // different case, same key
  });

  assert.equal(status, 409);
  assert.match(json.fields.username[0], /taken/);
});

test("the legacy single `name` is split into first and last on the next save", async () => {
  user = makeUser({ name: "Ana Maria Cruz" });

  const { json } = await send("PATCH", "/api/auth/me", {
    json: profile({ firstName: "Ana Maria", lastName: "Cruz" }),
  });

  assert.equal(json.user.firstName, "Ana Maria");
  assert.equal(user.name, undefined, "the old field is cleared once split");
});

test("an old single `name` is still read as a fallback when first/last are empty", async () => {
  user = makeUser({ name: "Ana Maria Cruz" });

  const { json } = await send("GET", "/api/auth/me");
  assert.equal(json.user.firstName, "Ana");
  assert.equal(json.user.lastName, "Maria Cruz");
});

// ---- POST /password ----------------------------------------------------------
test("changing the password needs the current one", async () => {
  user.password = await bcrypt.hash(PASSWORD, 10);

  const wrong = await send("POST", "/api/auth/password", {
    json: { currentPassword: "not it", newPassword: "a new long one" },
  });
  assert.equal(wrong.status, 400);
  assert.ok(wrong.json.fields.currentPassword);

  const { status } = await send("POST", "/api/auth/password", {
    json: { currentPassword: PASSWORD, newPassword: "a new long one" },
  });
  assert.equal(status, 204);
  assert.ok(
    await bcrypt.compare("a new long one", saved.password),
    "the new hash was written",
  );
});

test("the new password must differ from the current one", async () => {
  user.password = await bcrypt.hash(PASSWORD, 10);

  const { status, json } = await send("POST", "/api/auth/password", {
    json: { currentPassword: PASSWORD, newPassword: PASSWORD },
  });
  assert.equal(status, 400);
  assert.ok(json.fields.newPassword);
});

test("a short new password -> 400", async () => {
  user.password = await bcrypt.hash(PASSWORD, 10);

  const { status, json } = await send("POST", "/api/auth/password", {
    json: { currentPassword: PASSWORD, newPassword: "short" },
  });
  assert.equal(status, 400);
  assert.ok(json.fields.newPassword);
});

// ---- Avatar ------------------------------------------------------------------
test("uploading a photo stores the file and returns the user", async () => {
  const { status, json } = await send("PUT", "/api/auth/avatar", {
    files: [png("me.png")],
  });

  assert.equal(status, 200);
  assert.match(json.user.avatarUrl, /^\/uploads\/[\w-]+\.png$/);
  assert.equal(filesOnDisk().length, 1);

  const served = await fetch(base + json.user.avatarUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
});

test("uploading again REPLACES the photo and deletes the old file", async () => {
  const first = await send("PUT", "/api/auth/avatar", { files: [png("one.png")] });
  const [oldFile] = filesOnDisk();

  const second = await send("PUT", "/api/auth/avatar", { files: [png("two.png")] });

  assert.equal(second.status, 200);
  assert.notEqual(second.json.user.avatarUrl, first.json.user.avatarUrl);
  assert.equal(filesOnDisk().length, 1);
  assert.ok(!filesOnDisk().includes(oldFile), "the replaced photo is gone");
});

test("removing the photo goes back to the initial and deletes the file", async () => {
  await send("PUT", "/api/auth/avatar", { files: [png()] });

  const { status, json } = await send("DELETE", "/api/auth/avatar");
  assert.equal(status, 200);
  assert.equal(json.user.avatarUrl, null);
  assert.deepEqual(filesOnDisk(), []);
});

test("a non-image or an SVG avatar is refused and nothing is left on disk", async () => {
  const text = await send("PUT", "/api/auth/avatar", {
    files: [{ data: Buffer.from("hello"), type: "text/plain", name: "a.txt" }],
  });
  assert.equal(text.status, 400);

  const svg = await send("PUT", "/api/auth/avatar", {
    files: [{ data: SVG, type: "image/svg+xml", name: "a.svg" }],
  });
  assert.equal(svg.status, 400);

  assert.deepEqual(filesOnDisk(), []);
  assert.equal(user.avatar, null);
});

test("no picture at all -> 400", async () => {
  const { status } = await send("PUT", "/api/auth/avatar");
  assert.equal(status, 400);
});

test("profile routes need a signed-in user", async () => {
  for (const [method, url] of [
    ["GET", "/api/auth/me"],
    ["PATCH", "/api/auth/me"],
    ["POST", "/api/auth/password"],
    ["PUT", "/api/auth/avatar"],
    ["DELETE", "/api/auth/avatar"],
  ]) {
    const { status } = await send(method, url, { json: profile(), auth: false });
    assert.equal(status, 401, `${method} ${url}`);
  }
});
