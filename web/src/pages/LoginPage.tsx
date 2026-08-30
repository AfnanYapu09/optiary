import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { useToast } from "../lib/toast.tsx";
import { signInWithGoogle, saveUserProfileToCloud } from "../lib/firebase.ts";
import "../styles/login.css";

const BULLETS = [
  "ปฏิทินติดตามความครบของข้อมูลรายวัน",
  "AI Chatbot ช่วยจด อ่านภาพ และตอบคำถามจากข้อมูลเก่า",
  "เทียบภาพข้ามช่วงเวลาและข้ามวันได้ 3 มุมมอง",
];

const ERRORS: Record<string, string> = {
  state: "ลิงก์เข้าสู่ระบบหมดอายุ กรุณาลองใหม่",
  denied: "ยกเลิกการเข้าสู่ระบบด้วย Google",
  exchange: "เชื่อมต่อกับ Google ไม่สำเร็จ",
};

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.8-2 5.1-4.4 6.7v5.6h7.1c4.2-3.8 6.6-9.5 6.6-16.3z"
      />
      <path
        fill="#34A853"
        d="M24 46c6 0 11-2 14.6-5.4l-7.1-5.6c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.7-3.9-12.4-9.1H4.3v5.8C7.9 41.1 15.4 46 24 46z"
      />
      <path fill="#FBBC05" d="M11.6 28c-.4-1.3-.7-2.6-.7-4s.3-2.7.7-4v-5.8H4.3A22 22 0 0 0 2 24c0 3.5.8 6.9 2.3 9.8l7.3-5.8z" />
      <path
        fill="#EA4335"
        d="M24 10.5c3.3 0 6.2 1.1 8.5 3.3l6.3-6.3C35 3.9 30 2 24 2 15.4 2 7.9 6.9 4.3 14.2l7.3 5.8c1.7-5.2 6.6-9.5 12.4-9.5z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const { config, refresh } = useSession();
  const [params] = useSearchParams();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [email, setEmail] = useState("");

  const error = params.get("error");
  const firebaseReady = config?.firebase ?? false;

  async function handleGoogleLogin() {
    setGoogleBusy(true);
    try {
      const fbUser = await signInWithGoogle();
      if (!fbUser) {
        // User closed or dismissed the popup
        return;
      }
      // Only the signed token travels to the server — it derives the identity
      // from that, so there is nothing else here worth sending.
      const idToken = await fbUser.getIdToken();
      const loginRes = await api.firebaseLogin(idToken);
      // Save profile in Cloud Firestore safely in the background
      if (loginRes?.user) {
        try {
          await saveUserProfileToCloud(loginRes.user);
        } catch (syncErr) {
          console.warn("Could not sync profile to cloud:", syncErr);
        }
      }
      await refresh();
      toast("เข้าสู่ระบบด้วย Google สำเร็จ!", "ok");
    } catch (err: any) {
      if (
        err?.code === "auth/popup-closed-by-user" ||
        err?.code === "auth/cancelled-popup-request" ||
        err?.message?.includes("popup-closed-by-user")
      ) {
        return;
      }
      if (err?.code === "auth/popup-blocked") {
        toast("เบราว์เซอร์บล็อกหน้าต่างป๊อปอัป กรุณาอนุญาตป๊อปอัปหรือเปิดแอปในแท็บใหม่", "err");
        return;
      }
      toast(err instanceof Error ? err.message : "เข้าสู่ระบบด้วย Google ไม่สำเร็จ", "err");
    } finally {
      setGoogleBusy(false);
    }
  }

  async function devLogin() {
    setBusy(true);
    try {
      await api.devLogin(email.trim() || undefined);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "เข้าสู่ระบบไม่สำเร็จ", "err");
    } finally {
      setBusy(false);
    }
  }

  const signIn = (
    <div className="login-form">
      <div className="login-form-head">
        <h2>เข้าสู่ระบบ</h2>
        <p>ใช้บัญชี Google ของคุณ ข้อมูลจะถูกซิงค์และบันทึกออนไลน์บน Cloud Firestore อัตโนมัติ</p>
      </div>

      {error ? <p className="login-error">{ERRORS[error] ?? "เข้าสู่ระบบไม่สำเร็จ"}</p> : null}

      <button
        type="button"
        id="google-login-btn"
        className={`google-btn${firebaseReady ? "" : " disabled"}`}
        disabled={googleBusy || !firebaseReady}
        onClick={() => void handleGoogleLogin()}
      >
        <GoogleMark />
        {googleBusy ? "กำลังเชื่อมต่อกับ Google…" : "ดำเนินการต่อด้วย Google"}
      </button>

      {config && !firebaseReady ? (
        <p className="login-hint">
          เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า Firebase — ตั้ง <code>FIREBASE_PROJECT_ID</code> หรือวางไฟล์{" "}
          <code>firebase-applet-config.json</code> เพื่อเปิดการเข้าสู่ระบบด้วย Google
        </p>
      ) : null}

      {config?.devLogin ? (
        <>
          <div className="login-or">
            <span />
            <em>OR</em>
            <span />
          </div>
          <div className="login-local">
            <input
              id="dev-email-input"
              className="field"
              placeholder="อีเมลของคุณ (เช่น user@gmail.com)"
              value={email}
              type="email"
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void devLogin();
              }}
            />
            <button
              id="dev-login-btn"
              className="btn login-local-btn"
              disabled={busy}
              onClick={() => void devLogin()}
            >
              {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าใช้งานแบบทดลอง (Local Demo)"}
            </button>
          </div>
        </>
      ) : null}

      <p className="login-terms">
        การเข้าสู่ระบบถือว่ายอมรับ <a href="#terms">เงื่อนไขการใช้งาน</a> และ{" "}
        <a href="#privacy">นโยบายข้อมูลวิจัย</a> · ภาพและข้อมูลทั้งหมดถูกเก็บอย่างปลอดภัยบน Cloud
      </p>
    </div>
  );

  return (
    <div className="login">
      <section className="login-hero">
        <div className="brand">
          <span className="diamond login-mark" />
          <b>OPTIARY</b>
        </div>

        <div className="login-pitch">
          <h1>
            บันทึกภาพตลาดทองคำ
            <br />
            <span>วันละ 5 ช่วงเวลา</span>
            <br />
            ให้กลายเป็นชุดข้อมูลวิจัย
          </h1>
          <p>
            เก็บภาพ Intraday, OI และ OI Chg ของ GC ในทุกช่วงเวลา ให้ AI ช่วยถอดตัวเลข จดโน้ต
            และสรุปออกมาเป็นกราฟเปรียบเทียบอัตโนมัติ
          </p>
          <ul>
            {BULLETS.map((text) => (
              <li key={text}>
                <i />
                {text}
              </li>
            ))}
          </ul>
        </div>

        <span className="login-footer mono">RESEARCH WORKSPACE · COMEX GC · v0.1</span>
      </section>

      <section className="login-panel">{signIn}</section>
    </div>
  );
}
