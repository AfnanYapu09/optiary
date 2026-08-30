/**
 * Verifies Firebase ID tokens without pulling in firebase-admin.
 *
 * A Firebase ID token is an RS256 JWT signed by Google. Verifying it needs only
 * Google's *public* signing certificates — no service-account key — so the
 * server can prove who the browser signed in as while holding no secret of its
 * own. Without this, `/api/auth/firebase-login` would have to trust whatever
 * identity the client claimed.
 */
import crypto from "node:crypto";
import { firebaseProjectId } from "./config.js";

const CERT_URL =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

/** Small clock-skew allowance, matching what Google's own libraries permit. */
const SKEW_SECONDS = 300;

export class FirebaseTokenError extends Error {}

export type FirebaseIdentity = {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
};

type CertCache = { certs: Record<string, string>; expiresAt: number };
let cache: CertCache | null = null;
let inFlight: Promise<Record<string, string>> | null = null;

async function fetchCerts(): Promise<Record<string, string>> {
  const response = await fetch(CERT_URL);
  if (!response.ok) {
    throw new FirebaseTokenError(`ดึงใบรับรองของ Google ไม่สำเร็จ (${response.status})`);
  }
  const certs = (await response.json()) as Record<string, string>;

  // Google rotates these roughly daily and advertises the lifetime in the
  // response headers; honour it rather than re-fetching on every sign-in.
  const control = response.headers.get("cache-control") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(control)?.[1] ?? 3600);
  cache = { certs, expiresAt: Date.now() + Math.max(maxAge, 60) * 1000 };
  return certs;
}

async function getCerts(): Promise<Record<string, string>> {
  if (cache && cache.expiresAt > Date.now()) return cache.certs;
  // Collapse concurrent sign-ins onto a single refresh.
  if (!inFlight) {
    inFlight = fetchCerts().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Resolves to the verified identity, or throws. Every failure path throws
 * `FirebaseTokenError` so the route can answer 401 without leaking detail.
 */
export async function verifyFirebaseIdToken(token: unknown): Promise<FirebaseIdentity> {
  if (!firebaseProjectId) {
    throw new FirebaseTokenError("เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า Firebase project");
  }
  if (typeof token !== "string" || !token) {
    throw new FirebaseTokenError("ไม่พบ ID token");
  }

  const parts = token.split(".");
  if (parts.length !== 3) throw new FirebaseTokenError("รูปแบบ ID token ไม่ถูกต้อง");
  const [headerPart, payloadPart, signaturePart] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerPart);
    payload = decodeSegment(payloadPart);
  } catch {
    throw new FirebaseTokenError("อ่าน ID token ไม่ได้");
  }

  if (header.alg !== "RS256") throw new FirebaseTokenError("อัลกอริทึมของ ID token ไม่ถูกต้อง");
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid) throw new FirebaseTokenError("ID token ไม่มี kid");

  const certs = await getCerts();
  let cert = certs[kid];
  if (!cert) {
    // An unknown kid usually means the cached set is stale, not a forgery.
    cache = null;
    cert = (await getCerts())[kid];
  }
  if (!cert) throw new FirebaseTokenError("ไม่รู้จักคีย์ที่ใช้เซ็น ID token");

  const publicKey = new crypto.X509Certificate(cert).publicKey;
  const signed = `${headerPart}.${payloadPart}`;
  const valid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(signed),
    publicKey,
    Buffer.from(signaturePart, "base64url"),
  );
  if (!valid) throw new FirebaseTokenError("ลายเซ็นของ ID token ไม่ถูกต้อง");

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isFinite(exp) || exp + SKEW_SECONDS < now) {
    throw new FirebaseTokenError("ID token หมดอายุแล้ว");
  }
  if (!Number.isFinite(iat) || iat - SKEW_SECONDS > now) {
    throw new FirebaseTokenError("เวลาออก ID token ไม่ถูกต้อง");
  }
  if (payload.aud !== firebaseProjectId) {
    throw new FirebaseTokenError("ID token ออกให้โปรเจกต์อื่น");
  }
  if (payload.iss !== `https://securetoken.google.com/${firebaseProjectId}`) {
    throw new FirebaseTokenError("ผู้ออก ID token ไม่ถูกต้อง");
  }

  const sub = typeof payload.sub === "string" ? payload.sub : "";
  if (!sub) throw new FirebaseTokenError("ID token ไม่มี subject");

  const email = typeof payload.email === "string" ? payload.email : "";
  if (!email) throw new FirebaseTokenError("บัญชีนี้ไม่มีอีเมล");

  return {
    sub,
    email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : undefined,
    picture: typeof payload.picture === "string" ? payload.picture : undefined,
  };
}
