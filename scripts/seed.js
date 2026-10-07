// Fills the sandbox database with sample collections so the app looks complete.
//
//   npm run seed                  -> seeds the demo account (demo@crumbs.test)
//   npm run seed -- me@email.com  -> seeds an existing account of yours
//
// It also creates three sample people (mika, jon, ana: password Password123!),
// makes mika and jon your friends, leaves a pending request from ana, shares
// some of your collections with them, and adds two collections THEY created and shared
// with you.
// It first DELETES the collections of you and those three people, so you can run it
// again at any time.
// Like reset-sandbox.js, it refuses to touch anything but the sandbox database.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");

process.loadEnvFile();

const { SANDBOX_DB_NAME, getDatabaseName } = require("../config/database");
const { UPLOAD_DIR, PUBLIC_UPLOAD_PATH } = require("../config/uploads");
const User = require("../models/User");
const Collection = require("../models/Collection");
const Friendship = require("../models/Friendship");
const { pairKeyFor } = Friendship;
const { Widget, widgetModels } = require("../models/Widget");
const { refreshCollectionSummary } = require("../services/collectionSummary");
const { getEmbedUrl } = require("../services/linkPreview");
const { todayInTimezone, addDays } = require("../utils/dates");

const dbName = getDatabaseName(process.env.MONGODB_URI ?? "");
if (dbName !== SANDBOX_DB_NAME) {
  console.error(`Refusing to seed: MONGODB_URI points at "${dbName}", not "${SANDBOX_DB_NAME}".`);
  process.exit(1);
}

// ---- Tiny PNG generator ------------------------------------------------------
// Makes a gradient picture without any image library, so the seed needs no
// downloads and works offline. A PNG is: signature + chunks (IHDR, IDAT, IEND),
// each chunk ending in a CRC checksum.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function makeGradientPng(width, height, from, to) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3); // first byte = filter type 0 (none)
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2; // 0 at top-left, 1 at bottom-right
      for (let channel = 0; channel < 3; channel += 1) {
        row[1 + x * 3 + channel] = Math.round(from[channel] + (to[channel] - from[channel]) * t);
      }
    }
    rows.push(row);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit, RGB colour, no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PALETTES = [
  [[255, 183, 94], [237, 100, 166]],
  [[94, 196, 255], [98, 90, 230]],
  [[129, 230, 160], [30, 144, 140]],
  [[255, 214, 102], [240, 98, 70]],
  [[190, 160, 255], [80, 60, 170]],
  [[255, 160, 160], [150, 60, 110]],
];

let imageCounter = 0;
function seedImage(label) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `seed-${imageCounter}.png`;
  const [from, to] = PALETTES[imageCounter % PALETTES.length];
  imageCounter += 1;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), makeGradientPng(480, 320, from, to));
  return {
    filename,
    originalName: `${label}.png`,
    url: `${PUBLIC_UPLOAD_PATH}/${filename}`,
    mimeType: "image/png",
    size: fs.statSync(path.join(UPLOAD_DIR, filename)).size,
  };
}

// ---- Sample data ------------------------------------------------------------
// Dates are offsets from today, so the demo always has upcoming, today, past
// and overdue collections no matter when you run it.
const today = todayInTimezone();
const inDays = (n) => addDays(today, n);

function link(url, title, description, siteName) {
  return {
    url,
    embedUrl: getEmbedUrl(new URL(url)),
    preview: { status: "ok", title, description, image: null, siteName, favicon: null },
  };
}

// Small helpers so the sample data reads like the page: each collection has ROWS, and
// each row has WIDGETS (N = notes, D = date, I = image, L = link).
const N = (body, items = []) => ({ type: "notes", body, checklist: items.map(([text, done]) => ({ text, done })) });
const D = (date, label = "") => ({ type: "date", date, label });
const I = (label) => ({ type: "image", label }); // gets a generated picture
const L = (url, title, description, siteName) => ({ type: "link", ...link(url, title, description, siteName) });

// owner: who created it ("me" is the account being seeded).
// share: friends it is shared with.
const SAMPLE_EVENTS = [
  {
    owner: "me", share: ["mika", "jon"],
    title: "Capstone Defense Rehearsal",
    description: "Run through the full demo twice before the panel.",
    tags: ["school", "work"], status: "planned",
    rows: [
      { name: "Plan", widgets: [
        N("Bring the laptop charger and a backup copy of the slides.", [["Seed the demo database", true], ["Test the validation error case", true], ["Test the not-found case", false], ["Print the rubric", false]]),
        D(inDays(3), "Defense day"),
        N("", [["Final slides exported", false]]),
      ] },
      { name: "Visuals", widgets: [I("Slide deck cover"), I("Architecture diagram"), I("Team photo")] },
      { name: "Reading", widgets: [L("https://developer.mozilla.org/en-US/docs/Web/HTTP/Status", "HTTP response status codes - MDN", "Reference for every HTTP status code.", "MDN Web Docs")] },
    ],
  },
  {
    owner: "me", share: ["jon"],
    title: "Weekend Hike",
    description: "Sunrise hike with the barkada.",
    tags: ["outdoors", "friends"], status: "planned",
    rows: [
      { name: "Info", widgets: [N("Start at 4:30 AM. Bring 2 liters of water each.", [["Pack headlamps", false], ["Book the jeepney", true]]), D(inDays(10), "Departure"), D(inDays(11), "Return")] },
      { name: "Photos", widgets: [I("Trail map"), I("Summit view"), I("Campsite")] },
      { name: "Playlists", widgets: [L("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "Trail playlist", "Songs for the walk up.", "YouTube"), L("https://developer.mozilla.org/", "Packing guide", "What to bring.", "MDN Web Docs")] },
    ],
  },
  {
    owner: "me", share: [],
    title: "Mom's Birthday Dinner",
    description: "Reserve a table for eight and sort out the cake.",
    tags: ["family"], status: "draft",
    rows: [
      { name: "To do", widgets: [N("She loves ube.", [["Reserve a table", false], ["Order the cake", false]]), D(inDays(25), "Dinner at 7 PM")] },
      { name: "Ideas", widgets: [I("Cake idea")] },
    ],
  },
  {
    owner: "me", share: ["mika"],
    title: "Study Group: Advanced Web",
    description: "Review Express middleware order and Mongoose validation.",
    tags: ["school"], status: "done",
    rows: [
      { name: "Notes", widgets: [N("Covered routers, error handlers and CORS.", [["Review middleware order", true], ["Practice status codes", true]]), D(inDays(-5), "Session")] },
      { name: "Reference", widgets: [L("https://expressjs.com/en/guide/error-handling.html", "Error handling - Express", "How Express catches and processes errors.", "Express")] },
    ],
  },
  {
    owner: "me", share: ["mika", "jon"],
    title: "Concert Night",
    description: "Doors open at 6. Meet at the north gate.",
    tags: ["music", "friends"], status: "planned", // the date has passed: shows as overdue
    rows: [
      { name: "Details", widgets: [N("", [["Print the tickets", false]]), D(inDays(-2), "Show date")] },
      { name: "Photos", widgets: [I("Ticket"), I("Stage")] },
    ],
  },
  {
    owner: "me", share: [],
    title: "Apartment Move",
    description: "Pack, label and move everything over the weekend.",
    tags: ["home"], status: "archived",
    rows: [
      { name: "Wrap-up", widgets: [N("All done. Keep the receipts for the deposit.", [["Pack the kitchen", true], ["Return the keys", true]]), D(inDays(-20), "Move-out")] },
      { name: "Floor plan", widgets: [I("Floor plan")] },
    ],
  },
  {
    owner: "me", share: ["mika"],
    title: "Book Club: Chapter 5",
    description: "Pick a book for next month too.",
    tags: ["reading", "friends"], status: "draft", // no date yet
    rows: [{ name: "Discussion", widgets: [N("Questions: Who is the narrator? Is the ending earned?")] }],
  },
  {
    owner: "me", share: [],
    title: "Brainstorm: App Ideas",
    description: "A dumping ground for ideas, no date needed.",
    tags: ["ideas"], status: "draft",
    rows: [
      { name: "Ideas", widgets: [N("Habit tracker, recipe organiser, split-bill app...")] },
      { name: "Someday", widgets: [] }, // an empty row: just the "Add widget" button
    ],
  },
  {
    owner: "me", share: [],
    title: "Fresh Collection",
    description: "A brand new collection: one empty row, ready to fill.",
    tags: [], status: "draft",
    rows: [{ name: "", widgets: [] }],
  },
  // ---- Collections other people created and shared WITH you ----
  {
    owner: "mika", share: ["me", "jon"],
    title: "Surprise Party for Ana",
    description: "Mika is organising. Keep it secret!",
    tags: ["friends", "party"], status: "planned",
    rows: [
      { name: "To do", widgets: [N("", [["Buy balloons", true], ["Pick up the cake", false], ["Tell everyone to arrive at 5", false]]), D(inDays(6), "Party time")] },
      { name: "Inspiration", widgets: [I("Venue"), I("Decor ideas"), L("https://developer.mozilla.org/", "Party playlist", "Songs everyone knows.", "Spotify")] },
    ],
  },
  {
    owner: "jon", share: ["me"],
    title: "Group Project Meetup",
    description: "Divide the tasks for the final presentation.",
    tags: ["school"], status: "planned",
    rows: [{ name: "Agenda", widgets: [N("Jon takes slides, you take the backend demo."), D(inDays(2), "After class")] }],
  },
];

const PEOPLE = ["mika", "jon", "ana"];

async function findOrCreateUser(email) {
  if (email) {
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) throw new Error(`No account with email ${email}. Register it first, then re-run.`);
    return user;
  }

  const demoEmail = "demo@crumbs.test";
  const existing = await User.findOne({ email: demoEmail });
  if (existing) return existing;

  console.log("Creating demo account: demo@crumbs.test / Password123!");
  return User.create({
    username: "demo",
    email: demoEmail,
    password: await bcrypt.hash("Password123!", 10),
  });
}

async function findOrCreatePerson(name) {
  const email = `${name}@crumbs.test`;
  const existing = await User.findOne({ email });
  if (existing) return existing;
  return User.create({ username: name, email, password: await bcrypt.hash("Password123!", 10) });
}

// Deletes everything this script created before, so it can run again.
async function clearOldData(users) {
  const ownerIds = Object.values(users).map((u) => u._id);
  const old = await Collection.find({ owner: { $in: ownerIds } }).select("_id").lean();
  const ids = old.map((collection) => collection._id);
  await Widget.deleteMany({ collectionId: { $in: ids } });
  await Collection.deleteMany({ _id: { $in: ids } });

  const { me, mika, jon, ana } = users;
  const pairs = [[me, mika], [me, jon], [me, ana], [mika, jon]];
  await Friendship.deleteMany({ pairKey: { $in: pairs.map(([a, b]) => pairKeyFor(a._id, b._id)) } });
  return ids.length;
}

async function createFriendships({ me, mika, jon, ana }) {
  const accepted = [[me, mika], [me, jon], [mika, jon]];
  for (const [a, b] of accepted) {
    await Friendship.create({ requester: a._id, recipient: b._id, status: "accepted" });
  }
  // Ana has asked to be your friend; accept it in the app to try the flow.
  await Friendship.create({ requester: ana._id, recipient: me._id, status: "pending" });
}

async function createCollection(sample, users, stamp) {
  const owner = users[sample.owner];
  const collection = await Collection.create({
    owner: owner._id,
    title: sample.title,
    description: sample.description,
    tags: sample.tags,
    status: sample.status,
    collaborators: sample.share.map((key) => users[key]._id),
    rows: sample.rows.map((row) => ({ name: row.name })),
    createdAt: stamp,
    updatedAt: stamp,
  });

  // collection.rows now have their ids; each widget points at its row.
  const widgets = [];
  sample.rows.forEach((row, rowIndex) => {
    row.widgets.forEach(({ type, label, ...data }, order) => {
      const base = { collectionId: collection._id, row: collection.rows[rowIndex]._id, createdBy: owner._id, order };
      widgets.push(
        new widgetModels[type](type === "image" ? { ...base, image: seedImage(label) } : { ...base, ...data }),
      );
    });
  });

  await Promise.all(widgets.map((widget) => widget.save()));
  await refreshCollectionSummary(collection._id);
}

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  // Make sure the indexes match the current schemas (see server.js).
  await Promise.all([Collection.syncIndexes(), Widget.syncIndexes(), Friendship.syncIndexes()]);

  const me = await findOrCreateUser(process.argv[2]);
  const [mika, jon, ana] = await Promise.all(PEOPLE.map(findOrCreatePerson));
  const users = { me, mika, jon, ana };

  const removed = await clearOldData(users);
  if (removed) console.log(`Removed ${removed} existing sample collection(s)`);

  await createFriendships(users);

  // A little time apart so "recently edited" and "newest" sort sensibly.
  let minutesAgo = SAMPLE_EVENTS.length;
  for (const sample of SAMPLE_EVENTS) {
    await createCollection(sample, users, new Date(Date.now() - minutesAgo * 60 * 1000));
    minutesAgo -= 1;
  }

  console.log(`Seeded ${SAMPLE_EVENTS.length} collections for ${me.email} (${dbName}).`);
  console.log("Friends: mika, jon. Pending request from: ana. Sample people use Password123!");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed: ", err.message);
  process.exit(1);
});
