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
| GET | `/health` | Liveness plus database connection state |

Login and register are rate limited to 10 attempts per 15 minutes per IP. On a shared network this can throttle colleagues; the window resets on its own.

`GET /` still returns the scaffold string `Initial commit!` and is not part of the API.

## Project layout

```
app.js                  bootstrap, middleware, startup guard
config/database.js      live/sandbox names and the guard
models/User.js          User schema
routes/auth.js          the auth endpoints
middleware/auth.js      JWT signing, cookie helpers, requireAuth
scripts/reset-sandbox.js
```

## Conventions

- CommonJS, double quotes, semicolons, 2-space indent.
- Zod validates every request body. Reuse `validationError()` in `routes/auth.js` for field-level 400s.
- The `password` field is `select: false`, so it never comes back from a query. Use `.select("+password")` only to compare a hash.
- `usernameLower` is the case-insensitive unique key; `username` keeps the display casing. A pre-validate hook keeps them in sync — do not set either directly.
- Never return a User document directly; call `.toPublic()`.

## Notes

- Changing an indexed field does not rebuild the index. Drop it manually.
- In production, cookies are marked `secure`, so the app must be served over HTTPS or sign-in will fail silently.
