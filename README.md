# Optiary

สมุดบันทึกภาพเพื่อทำวิจัย Data Option ของทองคำฟิวเจอร์ส COMEX (GC) — เก็บภาพ Intraday / OI / OI Chg
วันละ 5 ช่วงเวลา ให้ AI ถอดตัวเลขจากภาพ จดโน้ต และสรุปออกมาเป็นกราฟเปรียบเทียบ

Implementation of the Claude Design handoff in `design/` (see [Design handoff](#design-handoff)).

## Stack

| Layer    | Choice                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| Frontend | React 18 + Vite + TypeScript, hand-written CSS matching the design tokens     |
| Backend  | Node 22 + Express + TypeScript                                               |
| Storage  | SQLite via the built-in `node:sqlite`; uploaded screenshots on local disk    |
| Auth     | Google OAuth 2.0 (authorization code flow), HMAC-signed session cookie       |
| AI       | Claude (`claude-opus-5`) via `@anthropic-ai/sdk`                              |

No native modules and no ORM — `npm install` is pure JavaScript.

## Quick start

```bash
npm install

# Optional: load the sample QuikStrike screenshots from the design handoff
# into a demo account so the app opens with realistic data.
npm run seed

npm run dev            # API on :4000, web on :5173
```

Open http://localhost:5173. Without `GOOGLE_CLIENT_ID` the login screen offers a
local email sign-in (`demo@optiary.local` after seeding); with it, the Google
button works for real.

Copy `.env.example` to `.env` for the full list of settings. The two that matter
most:

- `ANTHROPIC_API_KEY` — turns on screenshot number-extraction and the chatbot.
  Without it the app runs fine; the AI features report that they are unconfigured.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — real Google sign-in. Add
  `http://localhost:4000/api/auth/google/callback` as an authorized redirect URI.

### Production

```bash
npm run build          # builds web/dist and compiles server to server/dist
NODE_ENV=production SESSION_SECRET=... npm start
```

The API process serves `web/dist` when it exists, so a single process serves the
whole app. `SESSION_SECRET` is required in production, and `ALLOW_DEV_LOGIN`
defaults to off there.

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
GET    /auth/google → /auth/google/callback OAuth
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
| `npm run dev`          | API + web dev servers together                    |
| `npm run build`        | Production build of both                          |
| `npm start`            | Run the built server (also serves `web/dist`)     |
| `npm run seed`         | Load the sample screenshots into the demo account |
| `npm run typecheck`    | `tsc --noEmit` across both workspaces             |
