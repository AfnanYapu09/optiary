import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { config } from "./config.js";

export const db = new DatabaseSync(path.join(config.dataDir, "optiary.db"));

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT UNIQUE,
  email       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  picture     TEXT,
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,           -- YYYY-MM-DD
  slot        TEXT NOT NULL,           -- morning|afternoon|evening|night|latenight
  note        TEXT NOT NULL DEFAULT '',
  tags        TEXT NOT NULL DEFAULT '[]',
  metrics     TEXT NOT NULL DEFAULT '{}',
  updated_at  TEXT NOT NULL,
  UNIQUE (user_id, date, slot)
);

CREATE TABLE IF NOT EXISTS images (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  slot        TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- intraday|oi|oichg
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, date, slot, kind)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread      TEXT NOT NULL,           -- 'global' or a YYYY-MM-DD date
  role        TEXT NOT NULL,           -- user|assistant
  content     TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries (user_id, date);
CREATE INDEX IF NOT EXISTS idx_images_user_date ON images (user_id, date);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (user_id, thread, created_at);
`);

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return crypto.randomUUID();
}
