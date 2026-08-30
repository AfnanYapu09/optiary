# Optiary

สมุดบันทึกภาพเพื่อทำวิจัย Data Option ของทองคำฟิวเจอร์ส COMEX (GC) — เก็บภาพ Intraday / OI / OI Chg
วันละ 5 ช่วงเวลา ให้ AI ถอดตัวเลขจากภาพ จดโน้ต และสรุปออกมาเป็นกราฟเปรียบเทียบ

Implementation of the Claude Design handoff in `design/` (see [Design handoff](#design-handoff)).

## Stack

| Layer    | Choice                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| Frontend | React 18 + Vite + TypeScript, hand-written CSS matching the design tokens      |
| Backend  | Node 22 + Express + TypeScript, one process serving both API and web           |
| Storage  | SQLite via the built-in `node:sqlite`; uploaded screenshots on local disk      |
| Auth     | Firebase Google sign-in or server-side Google OAuth; HMAC-signed session cookie |
| Cloud    | Optional Firestore mirror of notes and profile                                 |
| AI       | Claude (`claude-opus-5`) or Gemini, selected by which API key is set           |

No native modules and no ORM — installing is pure JavaScript.

## Quick start

```bash
npm install            # or: bun install (bun.lock is the checked-in lockfile)
npm run dev            # everything on http://localhost:3000
```

One process serves both halves: in development the server mounts Vite as
middleware, so there is no separate web port. Open http://localhost:3000.

The database auto-seeds with the sample QuikStrike screenshots from the design
handoff on first run, so the app opens with realistic data. Re-seed at any time
with `npm run seed`.

Sign in with **"เข้าใช้งานแบบทดลอง (Local Demo)"** — no configuration needed.

Copy `.env.example` to `.env` for the full list. The ones that matter:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | Turns on screenshot number-extraction and the chatbot. Without either, the app runs fine and the AI features report themselves unconfigured. |
| `FIREBASE_PROJECT_ID` | Enables Google sign-in via the Firebase popup. Falls back to `projectId` in `firebase-applet-config.json`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enables the server-side OAuth route instead. Add `http://localhost:3000/api/auth/google/callback` as an authorized redirect URI. |
| `SESSION_SECRET` | Required in production. Generated and cached under `DATA_DIR` in development. |
| `ALLOW_DEV_LOGIN` | Local email sign-in. On by default in development, **off in production** — see below. |

### Production

```bash
npm run build          # builds web/dist and compiles server to server/dist
NODE_ENV=production SESSION_SECRET=... npm start
```

In production the server stops mounting Vite and serves the built `web/dist`
instead, still as one process on `PORT` (default 3000).

**Two things are deliberately off in production.** `SESSION_SECRET` must be
supplied or the process refuses to start, and `ALLOW_DEV_LOGIN` defaults to
false — dev login accepts any email with no credentials whatsoever, so enabling
it on a reachable host would let anyone sign in as anyone. Set
`ALLOW_DEV_LOGIN=true` there only if you fully intend that.

### How sign-in is verified

The Firebase popup runs entirely in the browser, so the server cannot take the
client's word for who signed in. `/api/auth/firebase-login` accepts **only** a
Firebase ID token, verifies its RS256 signature against Google's published
certificates, and checks issuer, audience and expiry before minting a session
(`server/src/firebase-token.ts`). Any email, uid or name in the request body is
ignored — the identity comes from the verified token alone. No service-account
key is needed, since verification uses Google's public certificates.

## Screens

| Route                | Design | What it does                                                                 |
| -------------------- | ------ | ---------------------------------------------------------------------------- |
| `/login`             | 1a, 1h | Google sign-in, plus local sign-in in development                            |
| `/`                  | 1b     | Month calendar of capture completeness, today's slots, streak, AI observation |
| `/day/:date`         | 1c, 1h | Capture the 3 screenshots per slot, note + tags, extracted numbers, chat      |
| `/compare`           | 1d, 1e | Curtain slider, day × slot grid, and single-day timeline                      |
| `/chart`             | 1f     | Price vs open interest, KPI tiles, OI Chg per slot, dataset observation       |
| `/assistant`         | 1h     | The research assistant over the whole dataset                                 |
| `/settings`          | 1g     | Profile, slot windows and reminders, AI preferences, CSV export               |

## How the AI features work

**Screenshot extraction** (`server/src/ai/extract.ts`) sends every screenshot
stored for one slot in a single vision request and uses structured outputs
(`output_config.format` with a Zod schema) to get back closing price, call/put
open interest, net OI change, P/C ratio and a Thai summary. Unreadable fields
come back `null` rather than guessed. It runs automatically on upload when the
user's `autoExtract` setting is on, and on demand from the capture screen.

**The research assistant** (`server/src/ai/chat.ts`) is a streaming tool loop
with four tools over the user's own data: `get_day`, `search_notes`, `get_stats`
and `save_note`. Replies stream to the browser as Server-Sent Events; when the
model writes into a note the client gets a `note-saved` event and refreshes.
Every tool is scoped to the signed-in user, so the assistant can only ever read
and write that person's notebook.

Both use adaptive thinking and a cached system prefix.

## API

All routes are under `/api` and require the session cookie except `/health`,
`/auth/config` and the OAuth endpoints.

```
GET    /health                             liveness
GET    /auth/config                        which sign-in methods and AI are available
GET    /me                                 current user + slot definitions
GET    /auth/google → /auth/google/callback server-side OAuth
POST   /auth/firebase-login          exchange a verified Firebase ID token for a session
POST   /auth/dev-login | /auth/logout

GET    /calendar?month=YYYY-MM             per-day completeness + streak
GET    /days/:date                         all five slots with images, note, metrics
PUT    /days/:date/:slot                   save note / tags / metrics

POST   /images/:date/:slot/:kind           multipart upload (field `file`)
DELETE /images/:id
GET    /images/:id/file                    the image itself, owner only
GET    /library?kind=intraday|oi|oichg
POST   /extract/:date/:slot                run vision extraction now

POST   /chat                               SSE stream of the assistant's reply
GET    /chat/:thread                       transcript ('global' or a date)
DELETE /chat/:thread

GET    /stats?days=N                       series, per-slot averages, correlation
GET    /compare?left=DATE_slot&right=…     two captures with numeric deltas
GET    /export.csv                         the whole dataset
GET    /settings | PUT /settings | POST /settings/reset
```

## Data model

`users` → `entries` (one per date × slot: note, tags, extracted metrics) and
`images` (one per date × slot × kind, file on disk under `DATA_DIR/uploads`).
`messages` holds chat transcripts, keyed by a thread that is either `global` or
a date. Slots and image kinds are defined once in `server/src/domain.ts`.

## Design handoff

`design/` holds the original Claude Design bundle: the `.dc.html` prototype, the
conversation transcript that produced it, and the QuikStrike sample screenshots
the seed script loads. It is reference material, not part of the build.

## Scripts

| Command                | Effect                                            |
| ---------------------- | ------------------------------------------------- |
| `npm run dev`          | One process: API + Vite middleware on `PORT`       |
| `npm run build`        | Production build of both                          |
| `npm start`            | Run the built server (also serves `web/dist`)     |
| `npm run seed`         | Re-load the sample screenshots into the demo account |
| `npm run typecheck`    | `tsc --noEmit` across both workspaces             |
