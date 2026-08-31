import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { useToast } from "../lib/toast.tsx";
import { clockNow } from "../lib/format.ts";
import { saveUserProfileToCloud } from "../lib/firebase.ts";
import { SLOTS, type SlotId, type UserSettings } from "../lib/types.ts";
import {
  ACCENTS,
  getAccent,
  getThemeMode,
  setAccent,
  setThemeMode,
  type Accent,
  type ThemeMode,
} from "../lib/theme.ts";
import "../styles/settings.css";

const THEME_OPTIONS: Array<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "สว่าง" },
  { id: "dark", label: "มืด" },
  { id: "system", label: "ตามระบบ" },
];

const PREFS: Array<{ key: keyof UserSettings; name: string; desc: string }> = [
  {
    key: "autoExtract",
    name: "ให้ AI อ่านตัวเลขจากภาพอัตโนมัติ",
    desc: "ถอด Call/Put OI และ OI Chg ทันทีที่อัปโหลด",
  },
  {
    key: "dailyDigest",
    name: "สรุปประจำวันตอนปิดช่วงดึก",
    desc: "ส่งสรุป 5 ช่วงเข้าอีเมลทุกเช้า",
  },
  {
    key: "incompleteReminder",
    name: "เตือนเมื่อบันทึกไม่ครบ",
    desc: "แจ้งเตือนถ้าเลยเวลาช่วงไป 30 นาทีแล้วยังไม่มีภาพ",
  },
  {
    key: "contributeToModel",
    name: "ใช้ข้อมูลของฉันปรับปรุงโมเดล",
    desc: "ปิดไว้เป็นค่าเริ่มต้นสำหรับงานวิจัย",
  },
];

export default function SettingsPage() {
  const { user, applySettings, config } = useSession();
  const toast = useToast();
  const [draft, setDraft] = useState<UserSettings | null>(user?.settings ?? null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(getThemeMode());
  const [accent, setAccentState] = useState<Accent>(getAccent());

  useEffect(() => {
    if (user?.settings) setDraft(user.settings);
  }, [user?.settings]);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(user?.settings ?? null),
    [draft, user?.settings],
  );

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.saveSettings(draft);
      applySettings(result.settings);
      if (user) {
        void saveUserProfileToCloud({
          id: user.id,
          email: user.email,
          name: user.name,
          settings: result.settings,
        });
      }
      setSavedAt(clockNow());
      toast("บันทึกการตั้งค่าและซิงค์ Cloud เรียบร้อย", "ok");
    } catch (error) {
      toast(error instanceof Error ? error.message : "บันทึกไม่สำเร็จ", "err");
    } finally {
      setSaving(false);
    }
  }, [applySettings, draft, toast, user]);

  if (!draft || !user) return <div className="empty">กำลังโหลดการตั้งค่า…</div>;

  const setSlot = (id: SlotId, patch: Partial<UserSettings["slots"][SlotId]>) =>
    setDraft({ ...draft, slots: { ...draft.slots, [id]: { ...draft.slots[id], ...patch } } });

  return (
    <div className="settings">
      <header className="toolbar">
        <h1>ตั้งค่า</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="mono" style={{ fontSize: 10.5, color: "var(--t-40)" }}>
            {savedAt ? `SAVED ${savedAt}` : dirty ? "UNSAVED" : "SAVED"}
          </span>
          <button className="btn-gold" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}
          </button>
        </div>
      </header>

      {/* One column. The old left nav only scroll-jumped between five short
          sections that already fit on the page — pure chrome. */}
      <div className="settings-body">
        <div className="settings-main">
          <section className="settings-profile">
            <div
              className="avatar"
              style={
                user.picture
                  ? { width: 44, height: 44, backgroundImage: `url(${user.picture})`, backgroundSize: "cover" }
                  : { width: 44, height: 44 }
              }
            />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <span style={{ font: "400 15px/1.3 var(--thai)", color: "var(--ink)" }}>{user.name}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--t-40)", overflowWrap: "anywhere" }}>
                {user.email} · {user.provider === "google" ? "เชื่อมต่อผ่าน Google" : "บัญชีทดลองในเครื่อง"}
              </span>
            </div>
          </section>

          <section className="settings-section">
            <span className="eyebrow">หน้าตา</span>
            <div className="settings-rows">
              <div className="pref-row">
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                  <span>ธีม</span>
                  <small>มืดเป็นค่าเริ่มต้น เลือกสว่างหรือตามระบบได้</small>
                </div>
                <div className="seg">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      aria-pressed={themeMode === opt.id}
                      onClick={() => {
                        setThemeMode(opt.id);
                        setThemeModeState(opt.id);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pref-row">
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                  <span>โทนสี</span>
                  <small>สีเน้นของปุ่ม ลิงก์ และไฮไลต์</small>
                </div>
                <div className="accent-picker">
                  {ACCENTS.map((a) => (
                    <button
                      key={a.id}
                      className={`accent-dot${accent === a.id ? " active" : ""}`}
                      style={{ background: a.swatch }}
                      aria-label={a.label}
                      aria-pressed={accent === a.id}
                      title={a.label}
                      onClick={() => {
                        setAccent(a.id);
                        setAccentState(a.id);
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="settings-section">
            <span className="eyebrow">ช่วงเวลาบันทึก</span>
            <div className="settings-rows">
              {SLOTS.map((slot) => {
                const value = draft.slots[slot.id];
                return (
                  <div key={slot.id} className="slot-row">
                    <span className="slot-row-name">{slot.th}</span>
                    <input
                      type="time"
                      className="time-input mono"
                      value={value.from}
                      onChange={(event) => setSlot(slot.id, { from: event.target.value })}
                    />
                    <span className="mono" style={{ fontSize: 11, color: "var(--t-30)" }}>
                      →
                    </span>
                    <input
                      type="time"
                      className="time-input mono"
                      value={value.to}
                      onChange={(event) => setSlot(slot.id, { to: event.target.value })}
                    />
                    <div style={{ flex: 1 }} />
                    <label className="slot-remind">
                      เตือน
                      <input
                        type="time"
                        className="time-input mono"
                        value={value.remind}
                        onChange={(event) => setSlot(slot.id, { remind: event.target.value })}
                      />
                    </label>
                    <button
                      className="toggle"
                      role="switch"
                      aria-checked={value.enabled}
                      aria-label={`เปิดเตือนช่วง${slot.th}`}
                      onClick={() => setSlot(slot.id, { enabled: !value.enabled })}
                    >
                      <span />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="settings-section">
            <span className="eyebrow">ผู้ช่วย AI และข้อมูล</span>
            {config?.ai ? (
              <p className="settings-note">
                ผู้ช่วย AI พร้อมทำงาน — ใช้โมเดล <code>{config.aiModel?.model}</code>
              </p>
            ) : (
              <p className="settings-warn">
                ผู้ช่วย AI ยังใช้งานไม่ได้ — ตั้ง <code>GEMINI_API_KEY</code> หรือ{" "}
                <code>ANTHROPIC_API_KEY</code> บนเซิร์ฟเวอร์ แล้วรีสตาร์ท
              </p>
            )}
            <div className="settings-rows">
              {PREFS.map((pref) => (
                <div key={pref.key} className="pref-row">
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                    <span>{pref.name}</span>
                    <small>{pref.desc}</small>
                  </div>
                  <button
                    className="toggle"
                    role="switch"
                    aria-checked={Boolean(draft[pref.key])}
                    aria-label={pref.name}
                    onClick={() => setDraft({ ...draft, [pref.key]: !draft[pref.key] })}
                  >
                    <span />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <span className="eyebrow">สัญญาและการส่งออก</span>
            <div className="settings-rows">
              <div className="pref-row">
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
                  <span>สัญญาที่ติดตาม</span>
                  <small>แสดงบนแถบด้านบนและใช้กำกับภาพที่บันทึก</small>
                </div>
                <input
                  className="contract-input"
                  value={draft.contract}
                  onChange={(event) => setDraft({ ...draft, contract: event.target.value })}
                  placeholder="GC DEC26"
                />
              </div>
            </div>
            <div className="settings-actions">
              <a className="btn-gold" href="/api/export.csv" style={{ padding: "12px 18px" }}>
                ส่งออกชุดข้อมูลทั้งหมด (CSV)
              </a>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
