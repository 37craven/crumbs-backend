# Crumbs — Backend

The API for Crumbs. Express 5 + Mongoose on MongoDB Atlas. Plain CommonJS JavaScript, no build step.

The web client is a separate project: [`crumbs`](https://github.com/your-org/crumbs). You need both running for the app to work.

## Requirements

- Node.js **20.12 or newer** — check with `node -v`. This uses `process.loadEnvFile()`, which does not exist on older versions.
- A MongoDB Atlas account and access to the cluster.

## Setup

```bash
npm install
cp .env.example .env
```

Then edit `.env` and fill in two values:

**`MONGODB_URI`** — your MongoDB connection string. Development must point at the `crumbs_dev` database:

```
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster-host>/crumbs_dev?appName=Crumbs
```

**`JWT_SECRET`** — generate your own. **Do not copy anyone else's.**

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Sharing a `JWT_SECRET` between developers means a session token minted by one machine will validate on another. Generate your own every time.

If your password contains any of `@ : / # ?`, percent-encode it (`%40`, `%3A`, `%2F`, `%23`, `%3F`) or the connection string will break.

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NODE_ENV` | `development` | `production` enables secure cookies |
| `MONGODB_URI` | — | required |
| `JWT_SECRET` | — | required, the app refuses to start without it |
| `JWT_EXPIRES_IN` | `7d` | |
| `CLIENT_ORIGIN` | `http://localhost:5173` | origin allowed to call this API |

For production values, see `.env.production.example`.

## Run

```bash
npm start
```

You should see:

```
Server on http://localhost:3000
Connected to MongoDB (crumbs_dev)
```

If the database name in that line is `crumbs`, the app refuses to start — that is the safety guard below.

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Start the server |
| `npm run dev` | Start with `node --watch`, restarts on file changes |
| `npm run db:reset` | Empty the **sandbox** database |
| `npm run refresh` | Recompute every collection's card summary and search text in the sandbox (after an update that changes them) |
| `npm run seed` | Fill the sandbox with sample collections (`npm run seed -- you@email.com` seeds your own account) |
| `npm test` | Run the automated tests (no database needed) |
| `npm run smoke` | End-to-end check against a running server and the sandbox database |

## The two databases

This project never points at the live database during development. There are two on the cluster:

| Database | Used by |
|---|---|
| `crumbs_dev` | development, on your machine |
| `crumbs` | production only |

`config/database.js` enforces this at startup and the app **refuses to boot** on a mismatch:

- `NODE_ENV=development` pointing at `crumbs` → refuses
- `NODE_ENV=production` pointing at `crumbs_dev` → refuses

`npm run db:reset` has its own separate check and will only ever empty `crumbs_dev`.

## API

Base path `/api/auth`. Auth is a JWT in an **httpOnly cookie**, so browsers need no token handling. CORS is restricted to `CLIENT_ORIGIN` and credentials are allowed.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/register` | Create an account. `409` if the email or username is taken |
| POST | `/api/auth/login` | Sign in. `401` on bad credentials |
| POST | `/api/auth/logout` | Clear the cookie |
| GET | `/api/auth/me` | Current user, or `401` |
| PATCH | `/api/auth/me` | Change `firstName`, `lastName`, `username`, `email` (all four). `409` with per-field messages if taken |
| POST | `/api/auth/password` | Change password. `400` if `currentPassword` is wrong or unchanged. `204` on success |
| PUT | `/api/auth/avatar` | Set the profile photo (`multipart/form-data`, field `image`, 1 MB max). Replaces the old one and deletes its file |
| DELETE | `/api/auth/avatar` | Remove the profile photo, back to the initial. Deletes the file |
| GET | `/health` | Liveness plus database connection state |

Login and register are rate limited to 10 attempts per 15 minutes per IP. On a shared network this can throttle colleagues; the window resets on its own. Password changes get their own window of the same size.

`GET /me` also returns `friendsCount`. Other people are only ever described by `id`, `username`, `firstName`, `lastName` and `avatarUrl` — never an email.

`GET /` returns a plain `Crumbs API` string and is not part of the API.

## Collections, rows, widgets, friends and sharing API

A **collection** is one card on the Collections page. It is made of **rows**, and each row holds **widgets** (notes, date, image or link, in any mix, in any number). A new collection starts with **one empty row**. A creator can **share** a collection with people from their **friends list**; those people can edit it, and it appears in their Collections too. All routes below need the login cookie. Someone who is not part of a collection gets `404` for it, the same as for a missing one.

**Who can do what**

| | Creator | Collaborator |
|---|---|---|
| See and edit title, tags, rows, widgets, notes, checklists, pictures, links, dates | yes | yes |
| Change the status | yes | yes |
| Delete the collection | yes | no (403) |
| Add or remove other people | yes | no (403) |
| Leave the collection | no | yes |

### Collections

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/collections` | Collections I created plus collections shared with me, recently edited first (`?page&limit`). Powers the Collections grid |
| POST | `/api/collections` | Open a new collection: one empty row, no widgets. `title` is optional. With nothing in it the status is `new` (see below) |
| GET | `/api/collections/:id` | One collection with its rows and all its widgets |
| PATCH | `/api/collections/:id` | Change `title`, `description` or `tags` |
| DELETE | `/api/collections/:id` | Creator only. Deletes the collection, its widgets and its pictures for everyone |
| PATCH | `/api/collections/:id/status` | Move between `draft`, `planned`, `done`, `archived` (rules below) |
| GET | `/api/collections/search` | Multi-filter search (table below) |
| GET | `/api/collections/upcoming` | Open collections in the next `?days=30`, soonest first, with `daysUntil` |
| GET | `/api/collections/:id/widgets` | Just the widgets, in display order |
| POST | `/api/collections/:id/collaborators` | Creator only. Share with a friend. Body `{ "userId": "..." }` |
| DELETE | `/api/collections/:id/collaborators/:userId` | Creator removes anyone; a collaborator can only remove themselves (leave) |

### Rows

Rows are listed in `collection.rows`, top to bottom. At most 20 rows per collection.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/collections/:id/rows` | Add an empty row at the bottom. Body `{ "name"?: "..." }` |
| PATCH | `/api/collections/:id/rows/:rowId` | Rename a row. Body `{ "name": "..." }` (up to 40 characters, may be empty) |
| DELETE | `/api/collections/:id/rows/:rowId` | Delete the row, its widgets and their pictures |
| PATCH | `/api/collections/:id/rows/order` | Rearrange the rows. Body `{ "order": [rowId, ...] }` |
| POST | `/api/collections/:id/rows/:rowId/widgets` | Add a widget to the end of the row (see below) |
| PATCH | `/api/collections/:id/rows/:rowId/widgets/order` | Rearrange the widgets of one row. Body `{ "order": [widgetId, ...] }` |

### Widgets

Any widget type can be added to any row, any number of times (up to 30 widgets per row). Every widget carries its `rowId` and its `order` (0 is leftmost). Add one with `POST .../rows/:rowId/widgets`:

| Body | Result |
|---|---|
| `{ "type": "notes" }` | Notes widget. May also carry `body` (text) and `checklist` |
| `{ "type": "date" }` | Date widget. May also carry `date` (`YYYY-MM-DD`) and `label` |
| `{ "type": "image" }` | Empty image widget. The picture is uploaded next |
| `{ "type": "link", "url": "https://..." }` | Link widget. `url` is optional |

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/widgets/:id` | One widget |
| PATCH | `/api/widgets/:id` | Edit a `notes` (`body`, `checklist`), `date` (`date`, `label`) or `link` (`url`) widget |
| DELETE | `/api/widgets/:id` | Delete any widget (an image widget's picture goes with it) |
| PATCH | `/api/widgets/:id/checklist/:itemId` | Tick or untick one checklist item (`{ "done": true }`, or no body to toggle) |
| POST | `/api/widgets/:id/image` | Put the picture in an image widget (`multipart/form-data`, field `image`). Uploading again replaces it |
| DELETE | `/api/widgets/:id/image` | Empty the widget; the widget itself stays |
| POST | `/api/links/preview` | Look up a link (title, image, embed) without saving it. Body `{ "url": "..." }` |

**Notes** hold text and a checklist together, always. **Image widgets** hold exactly one picture and have no thumbnail; the first pictures in display order become the image tiles of the collection card.

### Friends

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/friends` | My friends |
| GET | `/api/friends/search?q=ma` | Find people by username (2+ characters). Each result has a `relationship`: `none`, `friends`, `request_sent`, `request_received` |
| GET | `/api/friends/requests` | Requests waiting for me (`incoming`) and ones I sent (`outgoing`) |
| POST | `/api/friends/requests` | Send a request. Body `{ "userId": "..." }`. If they already asked me, this accepts it |
| PATCH | `/api/friends/requests/:id/accept` | Accept a request sent to me |
| DELETE | `/api/friends/requests/:id` | Decline a request sent to me, or cancel one I sent |
| DELETE | `/api/friends/:userId` | Stop being friends. Collections already shared stay shared |

People are described by `id`, `username`, `firstName`, `lastName` and `avatarUrl`. Emails are never returned for anybody but yourself.

### Crumbs

A **crumb** is one photo on the signed-in user's Crumbs page. It is deliberately separate from a collection's image widgets: crumbs are a personal timeline, collections are shared and edited by several people. An upload can do both at once.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/crumbs` | My crumbs, newest first |
| POST | `/api/crumbs` | Upload a photo (`multipart/form-data`, field `image`, 5 MB max). Optional fields: `caption` (60 characters), `collectionId` |
| DELETE | `/api/crumbs/:id` | Remove one of my crumbs |

**Filing a crumb into a collection.** Sending `collectionId` also files the picture into that collection as an image widget on its **first row**. You must be able to edit the collection, or you get a `404` like anyone else would.

The response says what happened:

```json
{
  "crumb": { "id": "6650c1...", "imageUrl": "/uploads/8f2a....jpg", "caption": "sunrise", "collectionId": "6650f1...", "createdAt": "..." },
  "filedInCollection": true,
  "collectionCopyError": null
}
```

- **One file, two records.** The crumb and the widget point at the same file on disk. Deleting either one leaves the file in place while the other still needs it.
- **A refused copy does not lose the photo.** If the collection is gone or not yours, the crumb is still saved, `collectionId` comes back `null` and `collectionCopyError` explains why.

### Search filters

All filters are optional and combine with AND.

| Parameter | Example | Meaning |
|---|---|---|
| `q` | `trip budget` | Every word must appear in the title, description, tags, a row name, a notes widget or checklist item, a date (as `2026-12-25`, the month name `december`, or the year `2026`), a date label, a link, or a picture name |
| `scope` | `shared` | `all` (default), `mine` (I created) or `shared` (shared with me) |
| `status` | `planned,done` | Any of these statuses |
| `tags` | `school,work` | Has **all** of these tags |
| `has` | `image,date` | Has content: `notes`, `image` (a picture), `date`, `link` |
| `dateFrom`, `dateTo` | `2026-10-01` | Any date widget of the collection within the range (collections with no date never match) |
| `sort` | `date_asc` | `recent` (default), `newest`, `oldest`, `title`, `date_asc`, `date_desc`. No-date collections always sort last |
| `page`, `limit` | `1`, `12` | Paging (`limit` max 50) |

### Business rules

- **Blank collections.** Opening a new collection creates it with status `new`. It is not listed in Collections or Search. The first title, tag, description or widget turns it into a `draft` automatically. If the user leaves without adding anything the frontend deletes it (`DELETE /api/collections/:id`); blank collections still left after an hour are removed the next time that user loads `GET /api/collections`.
- **Card tiles.** Each collection in a list carries `summary.tiles`: up to four tiles in the order date, note, image, link. A kind that is missing frees a slot, and free slots are filled with more pictures, then links, dates and notes. `summary.imageCount` is the "memories" count.
- **Next statuses.** Each collection carries `nextStatuses`, the statuses it can move to right now. Use it for the status dropdown, so impossible moves are never offered.
- **Friends only.** A collection can only be shared with people on the creator's friends list (`400` otherwise). At most 20 people per collection.
- **Status moves.** `draft` to `planned` or `archived`; `planned` to `draft`, `done` or `archived`; `done` to `planned` or `archived`; `archived` to `draft`. Anything else is `409`.
- **Planning needs a date.** A collection can only become `planned` once at least one date widget has a date.
- **Finishing needs finished checklists.** Every checklist item in every notes widget must be ticked before the collection can become `done`.
- **Several dates.** A collection can have many date widgets. Its card date (`summary.collectionDate`) is the **earliest**, and that one drives sorting, "upcoming" and "overdue". A date-range search matches a collection if **any** of its dates is in the range.
- **Overdue.** A `planned` collection whose card date has passed is returned with `isOverdue: true`.
- **Dates are calendar days.** They are stored as `YYYY-MM-DD` text, not timestamps, so a date never shifts across timezones. "Today" is decided by `APP_TIMEZONE`.
- **Derived values are never stored.** `daysUntil`, `dateStatus`, `isOverdue` and `role` are worked out on every read.
- **Link safety.** Pasted links are fetched by the server to build the preview. Private, local and non-http(s) addresses are refused, redirects are re-checked, and responses are capped at 512 KB and 5 seconds. A site that cannot be reached still saves, with `preview.status: "unavailable"`.
- **Pictures.** JPEG, PNG, WebP or GIF, up to 5 MB, one per image widget. Files are stored in `uploads/` under random names and served from `/uploads/<name>`. Replacing or removing a picture, or deleting its widget, row or collection, deletes the file. A profile photo has the same rules with a 1 MB limit.
- **One file can back two records.** A crumb filed into a collection shares its file with that collection's image widget. The file is only deleted once nothing refers to it any more.
- **Names.** `firstName` and `lastName` are each up to 50 characters and may be empty. Accounts created before the split kept one `name` field: it is read as a fallback and cleared the next time the profile is saved.

### Sample: create a collection, then build it up

`POST /api/collections`

```json
{}   // or { "title": "Weekend Hike", "tags": ["Outdoors"], "collaborators": ["6650a1..."] }
```

`201 Created`: one empty row, no widgets, status `new`.

```json
{
  "collection": {
    "id": "6650f1...",
    "title": "Weekend Hike",
    "status": "new",
    "role": "owner",
    "owner": { "id": "6650a0...", "username": "jian" },
    "collaborators": [{ "id": "6650a1...", "username": "mika" }],
    "rows": [{ "id": "6650f2...", "name": "" }],
    "nextStatuses": [], "summary": { "collectionDate": null, "collectionDates": [], "imageCount": 0, "linkCount": 0, "tiles": [] }
  },
  "widgets": []
}
```

`POST /api/collections/6650f1.../rows/6650f2.../widgets` with `{ "type": "notes", "body": "Start at 4:30 AM", "checklist": [{ "text": "Pack headlamps" }] }` gives `201`:

```json
{
  "widget": { "id": "6650f3...", "rowId": "6650f2...", "type": "notes", "order": 0, "body": "Start at 4:30 AM", "checklist": [{ "id": "...", "text": "Pack headlamps", "done": false }] },
  "collection": { "id": "6650f1...", "status": "draft", "summary": { "tiles": [{ "type": "note", "text": "Start at 4:30 AM" }] } }
}
```

### Sample: errors

Every error has the same shape. `fields` appears only for validation problems, with nested names joined by dots.

`POST /api/collections` with `{ "title": "", "collaborators": ["nope"] }` gives `400`:

```json
{
  "message": "Validation failed",
  "fields": {
    "title": ["Title is required"],
    "collaborators.0": ["Invalid id"]
  }
}
```

| Status | When |
|---|---|
| `400` | Validation failed, malformed id, malformed JSON, or sharing with someone who is not a friend |
| `401` | Not signed in |
| `403` | Only the creator may do this (delete the collection, manage people) |
| `404` | Collection or widget not found, or you are not part of it, or unknown route |
| `409` | Status move not allowed, already a friend / already shared, or the record changed while you were editing it |
| `413` | Image over 5 MB |
| `500` | Unexpected server error (details are logged, not sent) |

## Project layout

```
server.js               loads .env, connects to MongoDB, syncs indexes, starts listening
app.js                  middleware and route mounting only
config/database.js      live/sandbox names and the guard
config/uploads.js       upload folder, size and type limits
models/                 User, Collection, Widget (+ notes/image/date/link types), Friendship, Crumb
routes/                 auth, collections, rows, widgets, links, friends, crumbs, health
validators/             Zod schemas for request bodies and query strings
services/               business logic: access rules, friends, status rules, card tiles, search,
                        summaries, link previews, serializers, payload builders, crumbs
middleware/             auth, logger, 404, error handler, id check, uploads
utils/                  dates, HttpError
scripts/                reset-sandbox, seed, smoke
tests/                  node:test suites (npm test)
uploads/                uploaded images (git-ignored)
```

## Conventions

- CommonJS, double quotes, semicolons, 2-space indent.
- Zod validates every request body. `routes/auth.js` has its own `validationError()`; the collections code uses `parseOrThrow()` from `validators/common.js`. Both give the same `{ message, fields }` shape.
- Throw `new HttpError(status, message)` from routes and services instead of writing error responses by hand. `middleware/errorHandler.js` formats them.
- Routes parse input and shape output; rules live in `services/`.
- The `password` field is `select: false`, so it never comes back from a query. Use `.select("+password")` only to compare a hash.
- `usernameLower` is the case-insensitive unique key; `username` keeps the display casing. A pre-validate hook keeps them in sync — do not set either directly.
- Never return a User document directly; call `.toPublic()` for yourself and `.toSummary()` for anybody else. Neither ever includes the password or, for other people, the email.
- Uploaded files are referenced by `filename` in the database and `url` in responses. `filename` is never sent to clients. `services/imageFiles.js` owns deleting files, and `publicUrl()` builds the address.
- Anything that deletes a file has to consider that one file may back both a crumb and an image widget — use `services/crumbs.js:removeFileUnlessShared()`.

## Notes

- Changing an indexed field does not rebuild the index. Drop it manually.
- In production, cookies are marked `secure`, so the app must be served over HTTPS or sign-in will fail silently.
- Renaming a Mongoose model renames the JavaScript side only. `syncIndexes()` in `server.js` does not rename the MongoDB collection, so an old `events` collection is left behind — run `npm run db:reset` after the Collection rename.
