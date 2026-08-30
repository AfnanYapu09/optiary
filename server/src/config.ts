import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const root = path.resolve(process.cwd());

function bool(v: string | undefined, dflt = false): boolean {
  if (v === undefined) return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** Public origin of the web app, used for OAuth redirects and CORS. */
  webOrigin: process.env.WEB_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`,
  /** Public origin of this API, used to build the OAuth redirect URI. */
  apiOrigin: process.env.API_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`,

  dataDir: process.env.DATA_DIR ?? path.join(root, "data"),

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL ?? "gemini-3.7-flash",
  },

  anthropic: {
    // The SDK reads ANTHROPIC_API_KEY (or an `ant auth login` profile) itself.
    enabled: bool(process.env.AI_ENABLED, true),
    model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5",
  },

  /**
   * Dev login lets you sign in as any email with no credentials at all, so it
   * defaults to off in production — a deployed instance must never be walked
   * into. Setting ALLOW_DEV_LOGIN=true there is an explicit, deliberate opt-in.
   */
  allowDevLogin: bool(process.env.ALLOW_DEV_LOGIN, process.env.NODE_ENV !== "production"),

  sessionSecret: process.env.SESSION_SECRET ?? "",
  sessionMaxAgeMs: 1000 * 60 * 60 * 24 * 30,

  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 12 * 1024 * 1024),
};

/**
 * The Firebase web config is shipped with the app (its apiKey is a public
 * identifier, not a secret). The server only needs `projectId` from it, to
 * check the audience of the ID tokens the browser sends back.
 */
function readFirebaseProjectId(): string {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  for (const candidate of [
    path.resolve(process.cwd(), "firebase-applet-config.json"),
    path.resolve(process.cwd(), "../firebase-applet-config.json"),
  ]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8")) as { projectId?: string };
      if (parsed.projectId) return parsed.projectId;
    } catch {
      // Missing or malformed — fall through and report Firebase as unconfigured.
    }
  }
  return "";
}

export const firebaseProjectId = readFirebaseProjectId();

/** Server-side OAuth code flow — needs a client id *and* secret to work. */
export const googleOauthConfigured = Boolean(config.google.clientId && config.google.clientSecret);

/** Browser-side Firebase popup sign-in — needs a project to verify tokens against. */
export const firebaseAuthConfigured = Boolean(firebaseProjectId);

/** True when any Google sign-in route can actually complete. */
export const googleConfigured = googleOauthConfigured || firebaseAuthConfigured;


fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, "uploads"), { recursive: true });

/**
 * A stable secret is required to sign session cookies. In production it must be
 * supplied; in development we persist a generated one so restarts don't log you out.
 */
export function resolveSessionSecret(): string {
  if (config.sessionSecret) return config.sessionSecret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be set in production");
  }
  const file = path.join(config.dataDir, ".session-secret");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const generated = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, generated, { mode: 0o600 });
  return generated;
}

export const uploadsDir = path.join(config.dataDir, "uploads");
