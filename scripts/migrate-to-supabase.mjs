/**
 * One-off migration: local SQLite + data/uploads  ->  Supabase Postgres + Storage.
 *
 * Run it once, from the repo root, with the same Supabase credentials the server
 * uses. It is idempotent — rows are upserted by primary key and objects are
 * uploaded with upsert — so a failed run can simply be repeated.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/migrate-to-supabase.mjs
 *
 * Requires Node 22.5+ for the built-in SQLite reader.
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.SQLITE_PATH ?? path.join(repoRoot, "server", "data", "optiary.db");
const uploadsDir = process.env.UPLOADS_DIR ?? path.join(repoRoot, "server", "data", "uploads");

/**
 * Reads .env into the environment so the credentials never have to be typed on
 * a command line — where they would end up in shell history and in the terminal
 * transcript. Values already in the environment win.
 */
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(repoRoot, ".env"));

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this.");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`No SQLite database at ${dbPath}`);
  process.exit(1);
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const BUCKET = "optiary";

const db = new DatabaseSync(dbPath, { readOnly: true });

/**
 * Rows are inserted in dependency order: everything references users, so that
 * table has to land before the rest or the foreign keys reject the batch.
 */
const TABLES = [
  { name: "users", conflict: "id" },
  { name: "entries", conflict: "id" },
  { name: "images", conflict: "id" },
  { name: "messages", conflict: "id" },
  { name: "chat_attachments", conflict: "id" },
  { name: "day_news", conflict: "user_id,date" },
];

const CHUNK = 200;

for (const { name, conflict } of TABLES) {
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM ${name}`).all();
  } catch {
    console.log(`- ${name}: table missing locally, skipped`);
    continue;
  }
  if (!rows.length) {
    console.log(`- ${name}: nothing to copy`);
    continue;
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from(name).upsert(batch, { onConflict: conflict });
    if (error) {
      console.error(`! ${name}: ${error.message}`);
      process.exit(1);
    }
  }
  console.log(`- ${name}: ${rows.length} rows`);
}

// Screenshots and chat attachments keep the filename they had on disk, which is
// exactly the object key the server now reads, so the database rows need no
// rewriting — only the bytes have to be moved.
const filenames = new Set();
for (const table of ["images", "chat_attachments"]) {
  try {
    for (const row of db.prepare(`SELECT filename FROM ${table}`).all()) {
      if (row.filename) filenames.add(row.filename);
    }
  } catch {
    // Table absent locally — nothing to collect.
  }
}

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

let uploaded = 0;
let missing = 0;
for (const filename of filenames) {
  const source = path.join(uploadsDir, filename);
  if (!fs.existsSync(source)) {
    console.warn(`  missing on disk, skipped: ${filename}`);
    missing += 1;
    continue;
  }
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filename, fs.readFileSync(source), {
      contentType: MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? "application/octet-stream",
      upsert: true,
    });
  if (error) {
    console.error(`! upload ${filename}: ${error.message}`);
    process.exit(1);
  }
  uploaded += 1;
  if (uploaded % 25 === 0) console.log(`  ...${uploaded}/${filenames.size} files`);
}

console.log(`- storage: ${uploaded} files uploaded${missing ? `, ${missing} missing` : ""}`);
console.log("Migration complete.");
