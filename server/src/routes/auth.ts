import { Router } from "express";
import { config, firebaseAuthConfigured, googleOauthConfigured } from "../config.js";
import {
  clearSessionCookie,
  exchangeGoogleCode,
  googleAuthUrl,
  googleConfigured,
  makeOAuthState,
  readOAuthState,
  setSessionCookie,
  upsertGoogleUser,
  upsertLocalUser,
} from "../auth.js";
import { SLOTS } from "../domain.js";
import { aiReady } from "../ai/client.js";
import { FirebaseTokenError, verifyFirebaseIdToken } from "../firebase-token.js";

export const authRoutes = Router();

authRoutes.get("/auth/config", (_req, res) => {
  res.json({
    google: googleConfigured,
    googleOauth: googleOauthConfigured,
    firebase: firebaseAuthConfigured,
    devLogin: config.allowDevLogin,
    ai: aiReady(),
  });
});

authRoutes.get("/me", (req, res) => {
  if (!req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json({ user: req.user, slots: SLOTS });
});

/**
 * Completes a browser-side Firebase popup sign-in.
 *
 * The identity comes exclusively from the cryptographically verified ID token.
 * Anything else in the body (email, uid, name) is attacker-controlled and is
 * deliberately ignored — trusting it would let anyone mint a session as any
 * user by posting their address.
 */
authRoutes.post("/auth/firebase-login", async (req, res) => {
  if (!firebaseAuthConfigured) {
    res.status(503).json({ error: "ยังไม่ได้ตั้งค่า Firebase บนเซิร์ฟเวอร์" });
    return;
  }
  try {
    const identity = await verifyFirebaseIdToken(req.body?.idToken);
    const user = upsertGoogleUser({
      sub: identity.sub,
      email: identity.email,
      name: identity.name ?? identity.email.split("@")[0],
      picture: identity.picture,
    });
    setSessionCookie(res, user.id);
    res.json({ user, slots: SLOTS });
  } catch (error) {
    if (error instanceof FirebaseTokenError) {
      res.status(401).json({ error: error.message });
      return;
    }
    console.error("firebase login failed", error);
    res.status(500).json({ error: "เข้าสู่ระบบไม่สำเร็จ" });
  }
});

authRoutes.get("/auth/google", (req, res) => {
  if (!googleOauthConfigured) {
    res.status(503).json({ error: "google_not_configured" });
    return;
  }
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  res.redirect(googleAuthUrl(makeOAuthState(returnTo)));
});

authRoutes.get("/auth/google/callback", async (req, res) => {
  const state = readOAuthState(typeof req.query.state === "string" ? req.query.state : undefined);
  if (!state) {
    res.redirect(`${config.webOrigin}/login?error=state`);
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    res.redirect(`${config.webOrigin}/login?error=denied`);
    return;
  }
  try {
    const profile = await exchangeGoogleCode(code);
    const user = upsertGoogleUser(profile);
    setSessionCookie(res, user.id);
    res.redirect(`${config.webOrigin}${state.returnTo}`);
  } catch (error) {
    console.error("google callback failed", error);
    res.redirect(`${config.webOrigin}/login?error=exchange`);
  }
});

/**
 * Local sign-in for development and for evaluating the app before Google
 * credentials exist. Disabled in production by `ALLOW_DEV_LOGIN`.
 */
authRoutes.post("/auth/dev-login", (req, res) => {
  if (!config.allowDevLogin) {
    res.status(403).json({ error: "dev_login_disabled" });
    return;
  }
  const email = typeof req.body?.email === "string" && req.body.email.includes("@")
    ? req.body.email
    : "demo@optiary.local";
  const name = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name : "นักวิจัย (เดโม)";
  const user = upsertLocalUser(email, name);
  setSessionCookie(res, user.id);
  res.json({ user });
});

authRoutes.post("/auth/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});
