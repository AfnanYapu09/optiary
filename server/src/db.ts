import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

/**
 * Data lives in Supabase (Postgres + Storage) rather than a local SQLite file,
 * because every free host that stays up without a PC gives you an ephemeral
 * filesystem — a disk-backed database would be wiped on each restart or deploy.
 *
 * The server connects with the service_role key and does its own authorization:
 * every store function takes a `userId` and filters on it. That key bypasses RLS
 * and must never reach the browser, so it is read from the environment only.
 */
const url = process.env.SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

if (!url || !serviceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — the server cannot reach its database without them.",
  );
}

export const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Private bucket holding session screenshots and chat attachments. */
export const BUCKET = "optiary";

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return crypto.randomUUID();
}
