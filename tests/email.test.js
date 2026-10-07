// Exercises email verification and the forgot/reset password flow end to end
// through the real app. Mail is captured rather than sent, so there is no
// network and no SMTP needed to run this.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const User = require("../models/User");
const { hashToken } = require("../services/tokens");
const { useTestTransport, capturedMail } = require("../services/mailer");
const app = require("../app");

// ---- In-memory stand-ins for the database -----------------------------------
const accounts = new Map(); // _id -> document

function makeUser(overrides = {}) {
  const user = new User({
    username: "newcomer",
    usernameLower: "newcomer",
    email: "newcomer@example.com",
    password: bcrypt.hashSync("password123", 4),
    emailVerified: false,
    ...overrides,
  });
  user.save = async function save() {
    await this.validate();
    accounts.set(String(this._id), this);
    return this;
  };
  accounts.set(String(user._id), user);
  return user;
}

// bcrypt with a low cost, so the suite stays quick.
const originalHash = bcrypt.hash;
test.before(() => {
  bcrypt.hash = (plain) => originalHash(plain, 4);
});
test.after(() => {
  bcrypt.hash = originalHash;
});

User.create = async (data) => makeUser(data);

function matches(u, filter) {
  if (filter.email) return String(u.email).toLowerCase() === filter.email;
  if (filter.usernameLower) return u.usernameLower === filter.usernameLower;
  if (filter["emailVerifyToken.hash"]) {
    return u.emailVerifyToken?.hash === filter["emailVerifyToken.hash"];
  }
  if (filter["passwordResetToken.hash"]) {
    return u.passwordResetToken?.hash === filter["passwordResetToken.hash"];
  }
  if (filter.$or) {
    return filter.$or.some((clause) =>
      Object.entries(clause).some(([key, value]) => String(u[key]) === String(value)),
    );
  }
  return false;
}

const findDoc = (filter) => [...accounts.values()].find((u) => matches(u, filter)) ?? null;

// One stub for every shape the routes use: awaited directly, or with .select()
// or .lean() chained on. Resolving must be lazy so the three ways agree.
const query = (filter) => ({
  then: (resolve) => Promise.resolve(resolve(findDoc(filter))),
  select: async () => findDoc(filter),
  lean: async () => findDoc(filter),
});

User.findOne = query;
User.find = (filter) => ({
  select: () => ({
    lean: async () => [...accounts.values()].filter((u) => matches(u, filter)),
  }),
});
User.findById = async (id) => accounts.get(String(id)) ?? null;

// The verified response includes a friend count, which goes through the
// Friendship model. Nothing here is about friendships, so it always reports none.
const Friendship = require("../models/Friendship");
Friendship.find = () => ({ lean: async () => [] });
Friendship.findOne = () => ({ select: () => ({ lean: async () => null }) });

let server;
let base;
test.before(async () => {
  useTestTransport();
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());
test.beforeEach(() => {
  accounts.clear();
  capturedMail().length = 0;
});

// Pulls the token out of the most recent email's link.
function tokenFromLastMail() {
  const message = capturedMail().at(-1);
  assert.ok(message, "expected an email to have been sent");
  const match = message.text.match(/token=([a-f0-9]{64})/);
  assert.ok(match, `no token in the message body:\n${message.text}`);
  return match[1];
}

async function post(path, body, cookie) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: await res.json().catch(() => null),
    cookie: res.headers.get("set-cookie"),
  };
}

const register = (overrides = {}) =>
  post("/api/auth/register", {
    username: "newcomer",
    email: "newcomer@example.com",
    password: "password123",
    ...overrides,
  });

// ---- Registration -----------------------------------------------------------
test("registering creates an UNVERIFIED account and sends a link", async () => {
  const { status, json, cookie } = await register();

  assert.equal(status, 201);
  assert.equal(json.user.emailVerified, false);
  assert.equal(json.verificationEmailSent, true);
  assert.equal(cookie, null, "a new account must NOT be signed in yet");

  assert.equal(capturedMail().length, 1);
  assert.match(capturedMail()[0].to, /newcomer@example\.com/);
});

test("the emailed link carries the token, and the database only its hash", async () => {
  await register();
  const token = tokenFromLastMail();

  const stored = [...accounts.values()][0];
  assert.equal(stored.emailVerifyToken.hash, hashToken(token));
  assert.ok(
    !JSON.stringify(stored.emailVerifyToken).includes(token),
    "the raw token must never be stored",
  );
});

// ---- The gate ---------------------------------------------------------------
test("a correct password is refused until the address is verified", async () => {
  await register();

  const { status, json, cookie } = await post("/api/auth/login", {
    email: "newcomer@example.com",
    password: "password123",
  });

  assert.equal(status, 403);
  assert.equal(json.emailVerified, false);
  assert.match(json.message, /Confirm your email/);
  assert.equal(cookie, null);
});

test("a wrong password is still a plain 401, not a 403", async () => {
  await register();
  const { status } = await post("/api/auth/login", {
    email: "newcomer@example.com",
    password: "not the password",
  });
  assert.equal(status, 401);
});

// ---- Verifying --------------------------------------------------------------
test("a valid link verifies the account AND signs the user in", async () => {
  await register();
  const token = tokenFromLastMail();

  const { status, json, cookie } = await post("/api/auth/verify-email", { token });

  assert.equal(status, 200);
  assert.equal(json.user.emailVerified, true);
  assert.match(cookie ?? "", /crumbs_token=/, "verifying signs you in");

  // And now sign-in works.
  const login = await post("/api/auth/login", {
    email: "newcomer@example.com",
    password: "password123",
  });
  assert.equal(login.status, 200);
});

test("a link cannot be used twice", async () => {
  await register();
  const token = tokenFromLastMail();

  assert.equal((await post("/api/auth/verify-email", { token })).status, 200);

  const second = await post("/api/auth/verify-email", { token });
  assert.equal(second.status, 400);
});

test("an expired link is refused", async () => {
  await register();
  const token = tokenFromLastMail();

  // Age the stored token past its expiry.
  const stored = [...accounts.values()][0];
  stored.emailVerifyToken.expiresAt = new Date(Date.now() - 1000);

  const { status, json } = await post("/api/auth/verify-email", { token });
  assert.equal(status, 400);
  assert.match(json.message, /not valid or has expired/);
});

test("a made-up token is refused, with the same message as an expired one", async () => {
  await register();

  const invented = await post("/api/auth/verify-email", { token: "f".repeat(64) });
  assert.equal(invented.status, 400);
  assert.match(invented.json.message, /not valid or has expired/);
});

test("a token of the wrong shape is a validation error, not a lookup", async () => {
  await register();
  const { status, json } = await post("/api/auth/verify-email", { token: "short" });
  assert.equal(status, 400);
  assert.ok(json.fields.token);
});

// ---- Resending --------------------------------------------------------------
test("resending replaces the token, so the old link stops working", async () => {
  await register();
  const first = tokenFromLastMail();

  await post("/api/auth/resend-verification", { email: "newcomer@example.com" });
  const second = tokenFromLastLastMail();

  assert.notEqual(first, second);
  assert.equal((await post("/api/auth/verify-email", { token: first })).status, 400);
  assert.equal((await post("/api/auth/verify-email", { token: second })).status, 200);
});

function tokenFromLastLastMail() {
  return tokenFromLastMail();
}

test("resending says the same thing whether or not the account exists", async () => {
  const known = await post("/api/auth/resend-verification", { email: "newcomer@example.com" });
  const unknown = await post("/api/auth/resend-verification", { email: "nobody@example.com" });

  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.equal(known.json.message, unknown.json.message);
});

test("resending for an already-verified account sends nothing", async () => {
  await register();
  const token = tokenFromLastMail();
  await post("/api/auth/verify-email", { token });

  capturedMail().length = 0;
  const { status } = await post("/api/auth/resend-verification", {
    email: "newcomer@example.com",
  });

  assert.equal(status, 202);
  assert.equal(capturedMail().length, 0);
});

// ---- Forgot password --------------------------------------------------------
test("forgot-password sends a link and never reveals whether the account exists", async () => {
  await register();
  capturedMail().length = 0;

  const known = await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const unknown = await post("/api/auth/forgot-password", { email: "nobody@example.com" });

  assert.equal(known.status, 202);
  assert.equal(unknown.status, 202);
  assert.equal(known.json.message, unknown.json.message);
  assert.equal(capturedMail().length, 1, "only the real account gets mail");
});

test("resetting sets the new password and lets the old one go", async () => {
  await register();
  await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const token = tokenFromLastMail();

  const { status } = await post("/api/auth/reset-password", {
    token,
    newPassword: "a brand new password",
  });
  assert.equal(status, 204);

  // The new password works...
  const withNew = await post("/api/auth/login", {
    email: "newcomer@example.com",
    password: "a brand new password",
  });
  // ...and it is verified now, so sign-in is allowed at all.
  assert.equal(withNew.status, 200);

  // The old one does not.
  const withOld = await post("/api/auth/login", {
    email: "newcomer@example.com",
    password: "password123",
  });
  assert.equal(withOld.status, 401);
});

test("a reset link cannot be used twice", async () => {
  await register();
  await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const token = tokenFromLastMail();

  assert.equal(
    (await post("/api/auth/reset-password", { token, newPassword: "first new password" })).status,
    204,
  );
  assert.equal(
    (await post("/api/auth/reset-password", { token, newPassword: "second new password" })).status,
    400,
  );
});

test("an expired reset link is refused", async () => {
  await register();
  await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const token = tokenFromLastMail();

  [...accounts.values()][0].passwordResetToken.expiresAt = new Date(Date.now() - 1000);

  const { status } = await post("/api/auth/reset-password", {
    token,
    newPassword: "a new password",
  });
  assert.equal(status, 400);
});

test("a short new password is refused", async () => {
  await register();
  await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const token = tokenFromLastMail();

  const { status, json } = await post("/api/auth/reset-password", {
    token,
    newPassword: "short",
  });
  assert.equal(status, 400);
  assert.ok(json.fields.newPassword);
});

test("a verification token cannot be used to reset a password", async () => {
  await register();
  const verifyToken = tokenFromLastMail();

  const { status } = await post("/api/auth/reset-password", {
    token: verifyToken,
    newPassword: "a new password",
  });
  assert.equal(status, 400);
});

test("the reset password is stored hashed, never in the clear", async () => {
  await register();
  await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const token = tokenFromLastMail();

  await post("/api/auth/reset-password", { token, newPassword: "a brand new password" });

  const stored = [...accounts.values()][0].password;
  assert.ok(!stored.includes("a brand new password"));
  assert.ok(await bcrypt.compare("a brand new password", stored));
});

test("an already-verified account can still reset its password", async () => {
  await register();
  await post("/api/auth/verify-email", { token: tokenFromLastMail() });

  await post("/api/auth/forgot-password", { email: "newcomer@example.com" });
  const { status } = await post("/api/auth/reset-password", {
    token: tokenFromLastMail(),
    newPassword: "another new password",
  });

  assert.equal(status, 204);
  const login = await post("/api/auth/login", {
    email: "newcomer@example.com",
    password: "another new password",
  });
  assert.equal(login.status, 200);
});

// ---- Accounts that predate verification -------------------------------------
test("an account with no recorded decision is treated as UNVERIFIED (fail closed)", async () => {
  // emailVerified is undefined: this account predates the field. New accounts
  // always get an explicit `false`, so undefined can only be legacy data, and
  // the safe reading is "not proven yet". scripts/verify-existing-accounts.js is
  // what turns real legacy accounts into `true`.
  makeUser({
    emailVerified: undefined,
    email: "old@example.com",
    username: "olduser",
    usernameLower: "olduser",
  });

  const { status, json } = await post("/api/auth/login", {
    email: "old@example.com",
    password: "password123",
  });

  assert.equal(status, 403);
  assert.equal(json.emailVerified, false);
});

test("an account marked verified, as the migration does, signs in normally", async () => {
  makeUser({
    emailVerified: true,
    email: "moved@example.com",
    username: "moved",
    usernameLower: "moved",
  });

  const { status, json } = await post("/api/auth/login", {
    email: "moved@example.com",
    password: "password123",
  });

  assert.equal(status, 200);
  assert.equal(json.user.emailVerified, true);
});

test("toPublic reports a decided state either way, never undefined", async () => {
  const decided = makeUser({ emailVerified: true, email: "a@example.com", username: "aaa", usernameLower: "aaa" });
  const undecided = makeUser({ emailVerified: undefined, email: "b@example.com", username: "bbb", usernameLower: "bbb" });

  assert.equal(decided.toPublic().emailVerified, true);
  assert.equal(undecided.toPublic().emailVerified, false, "must be a real boolean");
});
