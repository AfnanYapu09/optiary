import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config, googleConfigured, resolveSessionSecret } from "./config.js";
import { db, nowIso, uid } from "./db.js";
import { defaultSettings, type UserSettings } from "./domain.js";

const SECRET = resolveSessionSecret();
const COOKIE = "optiary_session";

export type User = {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  /** How this account signed in — a local demo account has no Google identity. */
  provider: "google" | "local";
  settings: UserSettings;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}

function issueToken(userId: string): string {
  const body = Buffer.from(
    JSON.stringify({ sub: userId, exp: Date.now() + config.sessionMaxAgeMs }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readToken(token: string | undefined): string | null {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  // Both sides are fixed-length base64url digests, so a length mismatch here
  // means a malformed cookie rather than a timing-observable difference.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed.sub !== "string" || typeof parsed.exp !== "number") return null;
    if (parsed.exp < Date.now()) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}

export function setSessionCookie(res: Response, userId: string): void {
  res.cookie(COOKIE, issueToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.apiOrigin.startsWith("https://"),
    maxAge: config.sessionMaxAgeMs,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

type UserRow = {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  google_sub: string | null;
  settings: string;
};

function rowToUser(row: UserRow): User {
  let settings: UserSettings;
  try {
    settings = { ...defaultSettings(), ...(JSON.parse(row.settings) as UserSettings) };
  } catch {
    settings = defaultSettings();
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
    provider: row.google_sub ? "google" : "local",
    settings,
  };
}

export function getUser(id: string): User | null {
  const row = db
    .prepare("SELECT id, email, name, picture, google_sub, settings FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
  return row ? rowToUser(row) : null;
}

export function upsertGoogleUser(profile: {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}): User {
  const existing = db
    .prepare("SELECT id, email, name, picture, google_sub, settings FROM users WHERE google_sub = ? OR email = ?")
    .get(profile.sub, profile.email) as UserRow | undefined;

  if (existing) {
    db.prepare("UPDATE users SET google_sub = ?, name = ?, picture = ? WHERE id = ?").run(
      profile.sub,
      profile.name,
      profile.picture ?? null,
      existing.id,
    );
    return rowToUser({
      ...existing,
      name: profile.name,
      picture: profile.picture ?? null,
      google_sub: profile.sub,
    });
  }

  const id = profile.sub || uid();
  db.prepare(
    "INSERT INTO users (id, google_sub, email, name, picture, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    profile.sub,
    profile.email,
    profile.name,
    profile.picture ?? null,
    JSON.stringify(defaultSettings()),
    nowIso(),
  );
  return getUser(id)!;
}

/** Creates (or returns) the local demo account used when Google is not configured. */
export function upsertLocalUser(email: string, name: string): User {
  const existing = db
    .prepare("SELECT id, email, name, picture, google_sub, settings FROM users WHERE email = ?")
    .get(email) as UserRow | undefined;
  if (existing) return rowToUser(existing);

  const id = uid();
  db.prepare(
    "INSERT INTO users (id, google_sub, email, name, picture, settings, created_at) VALUES (?, NULL, ?, ?, NULL, ?, ?)",
  ).run(id, email, name, JSON.stringify(defaultSettings()), nowIso());
  return getUser(id)!;
}

export function attachUser(req: Request, _res: Response, next: NextFunction): void {
  const id = readToken(req.cookies?.[COOKIE]);
  if (id) {
    const user = getUser(id);
    if (user) req.user = user;
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// --- Google OAuth 2.0 (authorization code flow, no external dependency) ---

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

export function googleRedirectUri(): string {
  return `${config.apiOrigin}/api/auth/google/callback`;
}

/** Signs the OAuth `state` so the callback can verify it without server-side storage. */
export function makeOAuthState(returnTo: string): string {
  const body = Buffer.from(JSON.stringify({ returnTo, n: crypto.randomUUID() })).toString(
    "base64url",
  );
  return `${body}.${sign(body)}`;
}

export function readOAuthState(state: string | undefined): { returnTo: string } | null {
  if (!state) return null;
  const [body, mac] = state.split(".");
  if (!body || !mac) return null;
  const expected = sign(body);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const returnTo = typeof parsed.returnTo === "string" ? parsed.returnTo : "/";
    // Only allow same-app relative paths back, never an absolute URL.
    return { returnTo: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/" };
  } catch {
    return null;
  }
}

export function googleAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
    access_type: "online",
  });
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string): Promise<{
  sub: string;
  email: string;
  name: string;
  picture?: string;
}> {
  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`google token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("google token exchange returned no access_token");

  const infoRes = await fetch(GOOGLE_USERINFO, {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!infoRes.ok) throw new Error(`google userinfo failed: ${infoRes.status}`);
  const info = (await infoRes.json()) as {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!info.email) throw new Error("google account has no email");
  return {
    sub: info.sub,
    email: info.email,
    name: info.name ?? info.email.split("@")[0],
    picture: info.picture,
  };
}

export { googleConfigured };
