// End-to-end check of the collections, widgets, friends and sharing API against a
// RUNNING server.
//
//   1. npm run dev            (in one terminal, pointed at the crumbs_dev database)
//   2. npm run smoke          (in another)
//
// It registers two throwaway accounts (Ann and Ben), makes them friends, and
// walks through creating, sharing, editing and deleting a collection with rows and widgets. It prints
// PASS or FAIL for every step and exits with code 1 if anything failed.
// Leftover smoke accounts: npm run db:reset.
//
// Registration now creates an UNVERIFIED account and deliberately does not sign
// you in, so smoke checks that gate and then marks its own throwaway accounts
// verified. It does that through the database, because the verification token is
// only ever delivered by email and only its hash is stored. Every other step
// stays a real HTTP request.

const BASE = process.env.API_URL ?? "http://localhost:3000";
const NO_SUCH_ID = "000000000000000000000000";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

// Each person has their own login cookie.
const ann = { cookie: "", id: "" };
const ben = { cookie: "", id: "" };
let failures = 0;

function check(name, condition, detail = "") {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${!condition && detail ? `  -> ${detail}` : ""}`);
}

async function call(who, method, path, { json, form } = {}) {
  const headers = { ...(who.cookie && { Cookie: who.cookie }), ...(json && { "Content-Type": "application/json" }) };
  const res = await fetch(BASE + path, { method, headers, body: form ?? (json ? JSON.stringify(json) : undefined) });
  const setCookie = res.headers.getSetCookie?.()[0];
  if (setCookie) who.cookie = setCookie.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

const inDays = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);
const inAWeek = inDays(7);
const inTwoWeeks = inDays(14);

// Stable usernames, so repeated runs REUSE the same two accounts. Creating a
// fresh pair every run buried the sandbox in throwaway users and, because each
// registration counts against the per-address rate limit, made the harness
// throttle itself after a few runs.
const SMOKE_ACCOUNTS = { ann: "smoke_ann", ben: "smoke_ben" };
const SMOKE_PASSWORD = "Password123!";

// Registers the account if it is not there yet. Reports how it got there:
// { kind: "new" | "reused" | "failed" }. On a reused account the address is
// confirmed straight away, since the run before it should have.
async function ensureAccount(who, name) {
  const username = SMOKE_ACCOUNTS[name];
  const email = `${username}@crumbs.test`;

  const attempt = await call(who, "POST", "/api/auth/register", {
    json: { username, email, password: SMOKE_PASSWORD },
  });

  if (attempt.status === 201) {
    who.id = attempt.json.user.id;
    return { kind: "new", unverified: attempt.json.user.emailVerified === false };
  }

  // 409 means it already exists, which is the normal case from the second run.
  // No login attempt here: main() signs both in straight after, and every auth
  // call counts against the per-address rate limit.
  if (attempt.status === 409) {
    await confirmAccounts([username]);
    return { kind: "reused" };
  }

  return { kind: "failed", status: attempt.status };
}

// Marks the two throwaway accounts verified. The only step that touches the
// database directly, and only because the emailed token cannot be read from here.
async function confirmAccounts(usernames) {
  process.loadEnvFile();
  const mongoose = require("mongoose");
  await mongoose.connect(process.env.MONGODB_URI);
  // Matched on username, not _id: the ids arrive here as strings and Mongo
  // compares types strictly, so a string never matches an ObjectId.
  const result = await mongoose.connection.db
    .collection("users")
    .updateMany(
      { username: { $in: usernames } },
      { $set: { emailVerified: true, emailVerifiedAt: new Date() } },
    );
  if (result.modifiedCount !== usernames.length) {
    console.log(`WARN  could only confirm ${result.modifiedCount}/${usernames.length} accounts`);
  }
  await mongoose.disconnect();
}

async function main() {
  // Only used to keep this run's collection titles and tags distinct, so a
  // leftover from an earlier run is easy to recognise and delete.
  const tag = Math.random().toString(36).slice(2, 7);

  // ---- Accounts, email verification and friendship ------------------------
  const a = await ensureAccount(ann, "ann");
  const b = await ensureAccount(ben, "ben");
  check(
    "two smoke accounts ready",
    (a.kind === "new" || a.kind === "reused") && (b.kind === "new" || b.kind === "reused"),
    `ann:${a.kind} ben:${b.kind}`,
  );
  if (a.kind === "failed" || b.kind === "failed") return;

  if (a.kind === "new") {
    // Free assertions: the register response already tells us both facts. The
    // refusal itself (login -> 403) is covered in tests/email.test.js, where
    // rate limiting is inert.
    check(
      "a new account is unverified and is not signed in",
      a.unverified === true && ann.cookie === "",
    );
  }

  for (const who of [ann, ben]) {
    const name = who === ann ? "ann" : "ben";
    const email = `${SMOKE_ACCOUNTS[name]}@crumbs.test`;
    const res = await call(who, "POST", "/api/auth/login", { json: { email, password: SMOKE_PASSWORD } });
    // The id is needed by everything below; on the reuse path nothing else sets it.
    who.id = res.json?.user?.id ?? who.id;
    check(`${name} signs in`, res.status === 200 && who.cookie !== "", `${res.status}`);
    if (res.status !== 200) return;
  }

  const found = await call(ann, "GET", `/api/friends/search?q=${SMOKE_ACCOUNTS.ben}`);
  check("search finds Ben, relationship none", found.json?.users?.[0]?.id === ben.id && found.json.users[0].relationship === "none");
  check("search needs 2+ characters -> 400", (await call(ann, "GET", "/api/friends/search?q=a")).status === 400);

  const early = await call(ann, "POST", "/api/collections", { json: { title: "Too early", collaborators: [ben.id] } });
  check("sharing with a non-friend -> 400", early.status === 400 && early.json?.fields?.collaborators);

  check("cannot friend yourself -> 400", (await call(ann, "POST", "/api/friends/requests", { json: { userId: ann.id } })).status === 400);
  const sent = await call(ann, "POST", "/api/friends/requests", { json: { userId: ben.id } });
  check("send a friend request -> 201", sent.status === 201, `status ${sent.status}`);
  check("sending it twice -> 409", (await call(ann, "POST", "/api/friends/requests", { json: { userId: ben.id } })).status === 409);

  const incoming = await call(ben, "GET", "/api/friends/requests");
  const request = incoming.json?.incoming?.[0];
  check("Ben sees the request", request?.user?.id === ann.id);
  check("Ann sees it as outgoing", (await call(ann, "GET", "/api/friends/requests")).json?.outgoing?.length === 1);
  check("Ann cannot accept her own request -> 404", (await call(ann, "PATCH", `/api/friends/requests/${request?.id}/accept`)).status === 404);
  check("Ben accepts -> 200", (await call(ben, "PATCH", `/api/friends/requests/${request?.id}/accept`)).status === 200);
  check("both lists now show a friend",
    (await call(ann, "GET", "/api/friends")).json?.friends?.[0]?.id === ben.id &&
    (await call(ben, "GET", "/api/friends")).json?.friends?.[0]?.id === ann.id);

  // ---- A new collection starts with one empty row ----------------------------------
  const blank = await call(ann, "POST", "/api/collections", { json: {} });
  const blankId = blank.json?.collection?.id;
  check("opening a blank collection -> 201, status new, one empty row", blank.status === 201 && blank.json.collection.status === "new" && blank.json.collection.rows.length === 1, `status ${blank.status}`);
  check("a blank collection is not listed in Collections", !(await call(ann, "GET", "/api/collections")).json?.collections?.some((e) => e.id === blankId));
  const promoted = await call(ann, "PATCH", `/api/collections/${blankId}`, { json: { title: `Titled ${tag}` } });
  check("adding a title turns a blank collection into a draft", promoted.json?.collection?.status === "draft");
  check("clearing the title of an edited collection -> 400", (await call(ann, "PATCH", `/api/collections/${blankId}`, { json: { title: "" } })).status === 400);
  check("a blank collection the user leaves is deleted -> 200", (await call(ann, "DELETE", `/api/collections/${(await call(ann, "POST", "/api/collections", { json: {} })).json.collection.id}`)).status === 200);
  await call(ann, "DELETE", `/api/collections/${blankId}`);

  const created = await call(ann, "POST", "/api/collections", {
    json: { title: `Smoke test ${tag}`, tags: ["Smoke", "smoke", "Test"], collaborators: [ben.id] },
  });
  check("create a shared collection -> 201", created.status === 201, `status ${created.status}: ${JSON.stringify(created.json)}`);
  if (created.status !== 201) return;

  const collection = created.json.collection;
  check("it starts with ONE empty row and no widgets", collection.rows.length === 1 && created.json.widgets.length === 0, JSON.stringify(collection.rows));
  check("tags are lowercased and de-duplicated", collection.tags.join() === "smoke,test");
  check("a draft can only move to planned or archived (no done)", collection.nextStatuses.join() === "planned,archived", collection.nextStatuses.join());
  check("Ann is the owner, Ben a collaborator", collection.role === "owner" && collection.owner.id === ann.id && collection.collaborators[0]?.id === ben.id);
  check("the collection appears in Ben's Collections", (await call(ben, "GET", "/api/collections")).json?.collections?.some((e) => e.id === collection.id));
  check("Ben can rename the collection", (await call(ben, "PATCH", `/api/collections/${collection.id}`, { json: { title: `Smoke renamed ${tag}` } })).status === 200);

  // ---- Rows -----------------------------------------------------------------------
  const row1 = collection.rows[0].id;
  const rowsUrl = `/api/collections/${collection.id}/rows`;
  const addRow = await call(ann, "POST", rowsUrl, { json: { name: "Photos" } });
  check("add a second row -> 201", addRow.status === 201 && addRow.json.collection.rows.length === 2);
  const row2 = addRow.json?.collection?.rows?.[1]?.id;
  const renamed = await call(ben, "PATCH", `${rowsUrl}/${row1}`, { json: { name: "Plan" } });
  check("Ben renames the first row", renamed.status === 200 && renamed.json.collection.rows[0].name === "Plan");
  check("a row name over 40 characters -> 400", (await call(ann, "PATCH", `${rowsUrl}/${row1}`, { json: { name: "x".repeat(41) } })).status === 400);
  check("an unknown row -> 404", (await call(ann, "PATCH", `${rowsUrl}/${NO_SUCH_ID}`, { json: { name: "x" } })).status === 404);

  const flipped = await call(ann, "PATCH", `${rowsUrl}/order`, { json: { order: [row2, row1] } });
  check("reorder the rows", flipped.status === 200 && flipped.json.collection.rows.map((r) => r.id).join() === `${row2},${row1}`);
  check("reorder with a missing id -> 400", (await call(ann, "PATCH", `${rowsUrl}/order`, { json: { order: [row2] } })).status === 400);
  await call(ann, "PATCH", `${rowsUrl}/order`, { json: { order: [row1, row2] } }); // back to normal

  // ---- Widgets: any type, any row, as many as you like ----------------------------
  const add = (who, row, body) => call(who, "POST", `${rowsUrl}/${row}/widgets`, { json: body });
  const notesA = await add(ann, row1, { type: "notes", body: "plain text", checklist: [{ text: "first", done: true }, { text: "second" }] });
  const notesB = await add(ben, row1, { type: "notes", checklist: [{ text: "third" }] });
  const date1 = await add(ann, row1, { type: "date", date: inAWeek, label: "Launch" });
  const date2 = await add(ann, row1, { type: "date", date: inTwoWeeks, label: "Review" });
  const link1 = await add(ann, row1, { type: "link", url: "https://developer.mozilla.org/" });
  const image1 = await add(ann, row2, { type: "image" });
  const image2 = await add(ben, row2, { type: "image" });
  const all = [notesA, notesB, date1, date2, link1, image1, image2];
  check("add 2 notes, 2 dates, 1 link, 2 image widgets -> all 201", all.every((r) => r.status === 201), all.map((r) => r.status).join());
  check("a link widget fetches its preview (needs internet on the server)", ["ok", "unavailable"].includes(link1.json?.widget?.preview?.status));
  check("an unknown widget type -> 400", (await add(ann, row1, { type: "poem" })).status === 400);
  check("an image widget takes no url -> 400", (await add(ann, row1, { type: "image", url: "https://a.b" })).status === 400);
  check("a private link address -> 400", (await add(ann, row1, { type: "link", url: "http://127.0.0.1:3000" })).status === 400);
  check("adding to an unknown row -> 404", (await add(ann, NO_SUCH_ID, { type: "notes" })).status === 404);

  const listed = await call(ann, "GET", `/api/collections/${collection.id}`);
  const summary = listed.json?.collection?.summary;
  check("widgets come back row by row, left to right", listed.json?.widgets?.map((w) => w.type).join() === "notes,notes,date,date,link,image,image", listed.json?.widgets?.map((w) => w.type).join());
  check("every widget says which row it is in", listed.json?.widgets?.slice(0, 5).every((w) => w.rowId === row1) && listed.json.widgets.slice(5).every((w) => w.rowId === row2));
  check("the collection date is the EARLIEST date widget", summary?.collectionDate === inAWeek && summary.collectionDates.length === 2);
  check("the card has a note tile with the text", listed.json?.collection?.summary?.tiles?.find((t) => t.type === "note")?.text === "plain text");

  // ---- Notes: text AND checklist together ------------------------------------------
  const notes = notesA.json.widget;
  const textOnly = await call(ann, "PATCH", `/api/widgets/${notes.id}`, { json: { body: "edited text" } });
  check("editing the text keeps the checklist", textOnly.json?.widget?.body === "edited text" && textOnly.json.widget.checklist.length === 2);
  const tick = await call(ben, "PATCH", `/api/widgets/${notes.id}/checklist/${notes.checklist[1].id}`, { json: { done: true } });
  check("Ben ticks a checklist item", tick.status === 200 && tick.json.widget.checklist[1].done === true);
  check("there is no checklist progress report", tick.json?.widget?.checklistPercent === undefined && tick.json?.collection?.summary?.checklistPercent === undefined);
  check("a PATCH body must match the widget type -> 400", (await call(ann, "PATCH", `/api/widgets/${date1.json.widget.id}`, { json: { body: "x" } })).status === 400);

  // ---- One picture per image widget ----------------------------------------------------
  const form = (name) => { const f = new FormData(); f.append("image", new Blob([PNG], { type: "image/png" }), name); return f; };
  const imageId = image1.json.widget.id;
  const up1 = await call(ben, "POST", `/api/widgets/${imageId}/image`, { form: form("one.png") });
  const url1 = up1.json?.widget?.image?.url;
  check("Ben puts a picture in an image widget -> 201", up1.status === 201 && Boolean(url1), `status ${up1.status}`);
  check("the collection card gets an image tile and counts 1 memory", up1.json?.collection?.summary?.tiles?.some((t) => t.type === "image" && t.url === url1) && up1.json.collection.summary.imageCount === 1);
  check("the picture is served", (await fetch(BASE + url1)).status === 200);

  const up2 = await call(ann, "POST", `/api/widgets/${imageId}/image`, { form: form("two.png") });
  check("uploading again REPLACES the picture", up2.status === 201 && up2.json.widget.image.url !== url1);
  check("the replaced file is deleted from disk", (await fetch(BASE + url1)).status === 404);
  const twoFiles = new FormData();
  twoFiles.append("image", new Blob([PNG], { type: "image/png" }), "a.png");
  twoFiles.append("image", new Blob([PNG], { type: "image/png" }), "b.png");
  check("two files at once -> 400", (await call(ann, "POST", `/api/widgets/${imageId}/image`, { form: twoFiles })).status === 400);
  check("a picture cannot go into a notes widget -> 400", (await call(ann, "POST", `/api/widgets/${notes.id}/image`, { form: form("x.png") })).status === 400);

  const url2 = up2.json.widget.image.url;
  const emptied = await call(ann, "DELETE", `/api/widgets/${imageId}/image`);
  check("remove the picture: the widget stays but is empty", emptied.status === 200 && emptied.json.widget.image === null && emptied.json.collection.summary.imageCount === 0);
  check("its file is gone", (await fetch(BASE + url2)).status === 404);
  const up3 = await call(ann, "POST", `/api/widgets/${imageId}/image`, { form: form("three.png") });
  const url3 = up3.json?.widget?.image?.url;

  // ---- Arranging widgets inside a row -----------------------------------------------------
  const row1Ids = [notesA, notesB, date1, date2, link1].map((r) => r.json.widget.id);
  const reversed = [...row1Ids].reverse();
  const reorder = await call(ann, "PATCH", `${rowsUrl}/${row1}/widgets/order`, { json: { order: reversed } });
  check("reorder the widgets of a row", reorder.status === 200 && reorder.json.widgets.filter((w) => w.rowId === row1).map((w) => w.id).join() === reversed.join());
  check("reorder with a missing id -> 400", (await call(ann, "PATCH", `${rowsUrl}/${row1}/widgets/order`, { json: { order: reversed.slice(1) } })).status === 400);
  const goneLink = await call(ben, "DELETE", `/api/widgets/${link1.json.widget.id}`);
  check("delete a link widget -> 200", goneLink.status === 200 && goneLink.json.collection.summary.linkCount === 0);

  // ---- Search, scope and upcoming ----------------------------------------------------------
  const hit = async (who, qs) => (await call(who, "GET", `/api/collections/search?${qs}`)).json?.collections?.some((e) => e.id === collection.id);
  check("find it by text in a notes widget", await hit(ann, "q=edited"));
  check("find it by a checklist item", await hit(ann, "q=third"));
  check("find it by a row name", await hit(ann, "q=photos"));
  check("find it by a tag", await hit(ann, "q=smoke"));
  const month = new Date(inAWeek + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  check(`find it by the month of its date ("${month.toLowerCase()}")`, await hit(ann, `q=${month}`));
  check("find it by a short month name", await hit(ann, `q=${month.slice(0, 3)}`));
  check("Ben finds it too (shared with him)", await hit(ben, `q=${tag}`));
  check("scope=mine: Ann yes, Ben no", (await hit(ann, "scope=mine")) && !(await hit(ben, "scope=mine")));
  check("scope=shared: Ben yes, Ann no", (await hit(ben, "scope=shared")) && !(await hit(ann, "scope=shared")));
  check("filter has=notes,date,image", await hit(ann, "has=notes,date,image"));
  check("a date range finds the LATER of its two dates", await hit(ann, `dateFrom=${inTwoWeeks}&dateTo=${inTwoWeeks}`));
  check("a range with no date of this collection finds nothing", !(await hit(ann, "dateFrom=2000-01-01&dateTo=2000-12-31")));
  check("non-matching text excludes it", !(await hit(ann, "q=zzzznomatch")));
  for (const sort of ["recent", "newest", "oldest", "title", "date_asc", "date_desc"]) {
    check(`sort=${sort} works`, (await call(ann, "GET", `/api/collections/search?sort=${sort}`)).status === 200);
  }
  check("bad filter -> 400", (await call(ann, "GET", "/api/collections/search?scope=everyone")).status === 400);
  check("upcoming lists it for both of them",
    (await call(ann, "GET", "/api/collections/upcoming?days=30")).json?.collections?.some((e) => e.id === collection.id) &&
    (await call(ben, "GET", "/api/collections/upcoming?days=30")).json?.collections?.some((e) => e.id === collection.id));

  // ---- Status rules (anyone who can edit may change status) ---------------------------------
  const statusOf = (who, status) => call(who, "PATCH", `/api/collections/${collection.id}/status`, { json: { status } });
  check("draft -> done is refused (409)", (await statusOf(ann, "done")).status === 409);
  check("Ben can plan it (it has a date)", (await statusOf(ben, "planned")).status === 200);
  const blocked = await statusOf(ann, "done");
  check("planned -> done blocked by an open checklist item (409)", blocked.status === 409, blocked.json?.message);
  await call(ann, "PATCH", `/api/widgets/${notesB.json.widget.id}/checklist/${notesB.json.widget.checklist[0].id}`, { json: { done: true } });
  check("planned -> done works once every checklist item is ticked", (await statusOf(ann, "done")).status === 200);

  // ---- Permissions ----------------------------------------------------------------------------------
  check("Ben cannot delete the collection -> 403", (await call(ben, "DELETE", `/api/collections/${collection.id}`)).status === 403);
  check("Ben cannot add people -> 403", (await call(ben, "POST", `/api/collections/${collection.id}/collaborators`, { json: { userId: ann.id } })).status === 403);
  check("Ann cannot add Ben twice -> 409", (await call(ann, "POST", `/api/collections/${collection.id}/collaborators`, { json: { userId: ben.id } })).status === 409);
  check("Ann cannot be removed from her own collection -> 400", (await call(ann, "DELETE", `/api/collections/${collection.id}/collaborators/${ann.id}`)).status === 400);
  check("Ben leaves the collection -> 200", (await call(ben, "DELETE", `/api/collections/${collection.id}/collaborators/${ben.id}`)).status === 200);
  check("it disappears from Ben's account (404)", (await call(ben, "GET", `/api/collections/${collection.id}`)).status === 404);
  check("Ben can no longer edit its rows or widgets (404)",
    (await call(ben, "PATCH", `${rowsUrl}/${row1}`, { json: { name: "x" } })).status === 404 &&
    (await call(ben, "PATCH", `/api/widgets/${notes.id}`, { json: { body: "x" } })).status === 404);
  const readded = await call(ann, "POST", `/api/collections/${collection.id}/collaborators`, { json: { userId: ben.id } });
  check("Ann adds Ben again -> 201", readded.status === 201 && readded.json.collection.collaborators.length === 1);
  check("Ann removes Ben -> 200", (await call(ann, "DELETE", `/api/collections/${collection.id}/collaborators/${ben.id}`)).status === 200);

  // ---- Deleting a row takes its widgets and pictures with it ------------------------------------
  const delRow = await call(ann, "DELETE", `${rowsUrl}/${row2}`);
  check("delete the second row -> 200, reports what went", delRow.status === 200 && delRow.json.deleted.widgets === 2 && delRow.json.deleted.images === 1, JSON.stringify(delRow.json?.deleted));
  check("the row's picture file is gone", (await fetch(BASE + url3)).status === 404);
  check("one row is left", delRow.json?.collection?.rows?.length === 1);

  // ---- Delete the collection ----------------------------------------------------------------------------
  const del = await call(ann, "DELETE", `/api/collections/${collection.id}`);
  check("Ann deletes the collection -> 200 and it reports what was removed", del.status === 200 && del.json.deleted.widgets === 4, JSON.stringify(del.json)); // 2 notes + 2 dates are left: the link and the image row were deleted earlier
  check("deleted collection -> 404", (await call(ann, "GET", `/api/collections/${collection.id}`)).status === 404);
  check("unknown id -> 404, malformed id -> 400",
    (await call(ann, "GET", `/api/collections/${NO_SUCH_ID}`)).status === 404 && (await call(ann, "GET", "/api/collections/abc")).status === 400);

  // ---- Unfriend --------------------------------------------------------------------------------------
  check("Ann removes Ben as a friend -> 200", (await call(ann, "DELETE", `/api/friends/${ben.id}`)).status === 200);
  check("doing it again -> 404", (await call(ann, "DELETE", `/api/friends/${ben.id}`)).status === 404);
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("\nSmoke test crashed:", err.message);
    console.error(`Is the server running at ${BASE}?`);
    process.exit(1);
  });