import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, chatImageUrl, streamChat } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { useToast } from "../lib/toast.tsx";
import { saveChatMessageToCloud } from "../lib/firebase.ts";
import { slotDef, type ChatMessage, type ChatStats, type SlotId } from "../lib/types.ts";
import "../styles/assistant.css";

const nf = new Intl.NumberFormat("en-US");

/** "2.4 วิ" / "1 นาที 12 วิ" */
function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} วิ`;
  const m = Math.floor(s / 60);
  return `${m} นาที ${Math.round(s - m * 60)} วิ`;
}

function StatsLine({ stats }: { stats: ChatStats }) {
  const tokens = stats.inputTokens + stats.outputTokens;
  const parts = [
    stats.model,
    formatDuration(stats.ms),
    `${nf.format(tokens)} tokens (in ${nf.format(stats.inputTokens)} · out ${nf.format(stats.outputTokens)}${
      stats.thinkingTokens ? ` · คิด ${nf.format(stats.thinkingTokens)}` : ""
    })`,
  ];
  if (stats.cachedTokens) parts.push(`cache ${nf.format(stats.cachedTokens)}`);
  return <div className="assistant-stats">{parts.join("  ·  ")}</div>;
}

const SUGGESTIONS = ["สรุปทั้งวัน", "หาวันที่คล้ายกัน", "ตั้งสมมติฐาน"];

const TOOL_LABELS: Record<string, string> = {
  get_day: "กำลังอ่านบันทึกของวัน…",
  search_notes: "กำลังค้นบันทึกย้อนหลัง…",
  get_stats: "กำลังรวมตัวเลขย้อนหลัง…",
  list_days: "กำลังดูรายการวัน…",
  get_settings: "กำลังอ่านการตั้งค่า…",
  save_note: "กำลังบันทึกลงโน้ต…",
  save_news: "กำลังจดข่าวเศรษฐกิจ…",
  edit_note: "กำลังแก้โน้ต…",
  set_tags: "กำลังปรับแท็ก…",
  save_shot: "กำลังเก็บภาพเข้าคลัง…",
  save_metrics: "กำลังบันทึกตัวเลขที่อ่านได้…",
  update_settings: "กำลังปรับตั้งค่า…",
  delete_data: "กำลังจัดการลบข้อมูล…",
};

const MAX_ATTACHMENTS = 3;

type Props = {
  /** `global`, or a `YYYY-MM-DD` thread scoped to one day. */
  thread: string;
  slot?: SlotId;
  subtitle?: string;
  /** Called after the assistant writes into a note, so the page can refresh. */
  onNoteSaved?: (date: string, slot?: SlotId) => void;
  initialQuestion?: string;
};

export default function AssistantPanel({
  thread,
  slot,
  subtitle,
  onNoteSaved,
  initialQuestion,
}: Props) {
  const toast = useToast();
  const { user } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [lightbox, setLightbox] = useState<{ urls: string[]; index: number } | null>(null);
  const openLightbox = useCallback((urls: string[], index: number) => {
    if (urls.length) setLightbox({ urls, index });
  }, []);
  const stepLightbox = useCallback((delta: number) => {
    setLightbox((cur) =>
      cur ? { ...cur, index: (cur.index + delta + cur.urls.length) % cur.urls.length } : cur,
    );
  }, []);

  // Arrow keys page through the open lightbox; Escape closes it.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      else if (e.key === "ArrowRight") stepLightbox(1);
      else if (e.key === "ArrowLeft") stepLightbox(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, stepLightbox]);
  const scroller = useRef<HTMLDivElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const sentInitial = useRef(false);

  // A ticking "…12.3 วิ" while the model works, so a slow reply doesn't look hung.
  useEffect(() => {
    if (!streaming) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Date.now() - started), 200);
    return () => clearInterval(t);
  }, [streaming]);

  const addFiles = useCallback(
    (incoming: File[]) => {
      const images = incoming.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      setAttachments((current) => [...current, ...images].slice(0, MAX_ATTACHMENTS));
    },
    [],
  );

  // Object URLs are revoked on replacement so previews don't leak between turns.
  const previews = useMemo(
    () => attachments.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [attachments],
  );
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  useEffect(() => {
    api
      .chatHistory(thread)
      .then((res) => setMessages(res.messages))
      .catch(() => setMessages([]));
  }, [thread]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, partial, activity]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      const files = attachments;
      if ((!message && files.length === 0) || streaming) return;

      setDraft("");
      setAttachments([]);
      setStreaming(true);
      setPartial("");
      setActivity(null);
      const localPreviews = files.map((file) => ({ url: URL.createObjectURL(file), mime: file.type }));
      setMessages((current) => [
        ...current,
        {
          id: `local-${Date.now()}`,
          role: "user",
          content: message || (files.length ? "ช่วยอ่านภาพนี้แล้วจดให้หน่อย" : ""),
          meta: { attachments: localPreviews },
          createdAt: new Date().toISOString(),
        },
      ]);
      if (user?.id) {
        void saveChatMessageToCloud(user.id, "user", message || "[แนบภาพ]");
      }

      let answer = "";
      let stats: ChatStats | null = null;
      const saved: Array<{ date: string; slot: SlotId }> = [];

      try {
        await streamChat({ message, thread, slot, files }, (event) => {
          switch (event.type) {
            case "text":
              answer += event.text;
              setActivity(null);
              setPartial(answer);
              break;
            case "tool":
              setActivity(TOOL_LABELS[event.name] ?? "กำลังค้นข้อมูล…");
              break;
            case "note-saved":
              saved.push({ date: event.date, slot: event.slot });
              onNoteSaved?.(event.date, event.slot);
              break;
            case "shot-saved":
            case "metrics-saved":
              // Both write into the day the assistant picked, so the page behind
              // the panel has to reload that day just as a note save would.
              onNoteSaved?.(event.date, event.slot);
              break;
            case "data-changed":
              // Delete/clear tools; when a whole wipe leaves no date, fall back
              // to the panel's own thread so the page behind it still refreshes.
              onNoteSaved?.(event.date ?? thread, event.slot ?? slot);
              break;
            case "settings-changed":
              onNoteSaved?.(thread, slot);
              break;
            case "done":
              stats = event.stats;
              break;
            case "error":
              toast(event.message, "err");
              break;
            default:
              break;
          }
        });
      } catch (error) {
        toast(error instanceof Error ? error.message : "แชทล้มเหลว", "err");
      }

      setStreaming(false);
      setActivity(null);
      setPartial("");
      localPreviews.forEach((p) => URL.revokeObjectURL(p.url));

      // Pull the canonical transcript back so the user turn gets real attachment
      // ids (served from disk) and the assistant turn carries its saved stats.
      try {
        const res = await api.chatHistory(thread);
        setMessages(res.messages);
      } catch {
        if (answer.trim()) {
          setMessages((current) => [
            ...current,
            {
              id: `local-a-${Date.now()}`,
              role: "assistant",
              content: answer,
              meta: { savedNotes: saved, stats },
              createdAt: new Date().toISOString(),
            },
          ]);
        }
      }
      if (answer.trim() && user?.id) {
        void saveChatMessageToCloud(user.id, "assistant", answer);
      }
    },
    [attachments, onNoteSaved, slot, streaming, thread, toast, user?.id],
  );

  useEffect(() => {
    if (initialQuestion && !sentInitial.current) {
      sentInitial.current = true;
      void send(initialQuestion);
    }
  }, [initialQuestion, send]);

  return (
    <div className="assistant">
      <header className="assistant-head">
        <span className="diamond" style={{ width: 15, height: 15 }} />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <span style={{ font: "500 13px/1 var(--thai)", color: "var(--ink)" }}>ผู้ช่วยวิจัย</span>
          <span style={{ font: "300 10.5px/1.3 var(--thai)", color: "var(--t-40)" }}>
            {subtitle ?? "อ่านภาพ · จดโน้ต · ตอบจากข้อมูลเก่า"}
          </span>
        </div>
        {slot ? (
          <span className="mono" style={{ fontSize: 10, color: "var(--t-30)" }}>
            {slotDef(slot).th}
          </span>
        ) : null}
        <button
          className="linkish"
          title="ล้างประวัติแชท"
          onClick={async () => {
            await api.clearChat(thread);
            setMessages([]);
          }}
        >
          ล้าง
        </button>
      </header>

      <div className="assistant-log" ref={scroller}>
        {messages.length === 0 && !streaming ? (
          <div className="empty" style={{ padding: "28px 12px" }}>
            ถามได้เลย เช่น “อ่านภาพ OI ที่เพิ่งอัปโหลด แล้วจดสรุปให้ด้วย”
          </div>
        ) : null}

        {messages.map((message) => {
          const shots = (message.meta?.attachments ?? [])
            .map((a) => a.url ?? (a.id ? chatImageUrl(a.id) : null))
            .filter((u): u is string => Boolean(u));
          return message.role === "user" ? (
            <div key={message.id} className="bubble user">
              {shots.length ? (
                <div className="bubble-shots">
                  {shots.map((url, i) => (
                    <button
                      key={url}
                      type="button"
                      className="bubble-shot"
                      onClick={() => openLightbox(shots, i)}
                      aria-label="ดูรูปเต็ม"
                    >
                      <img src={url} alt="ภาพที่แนบ" />
                    </button>
                  ))}
                </div>
              ) : null}
              {message.content ? <p>{message.content}</p> : null}
            </div>
          ) : (
            <div key={message.id} className="bubble ai">
              <p>{message.content}</p>
              {message.meta?.savedNotes?.length ? (
                <div className="bubble-actions">
                  {message.meta.savedNotes.map((note) => (
                    <span key={`${note.date}-${note.slot}`} className="chip gold">
                      บันทึกลงโน้ต {note.date} · {slotDef(note.slot).th}
                    </span>
                  ))}
                </div>
              ) : null}
              {message.meta?.stats ? <StatsLine stats={message.meta.stats} /> : null}
            </div>
          );
        })}

        {partial ? (
          <div className="bubble ai">
            <p>{partial}</p>
          </div>
        ) : null}

        {activity ? (
          <div className="assistant-activity">
            <span className="spin" />
            {activity}
            <span className="assistant-timer">{formatDuration(elapsed)}</span>
          </div>
        ) : null}

        {streaming && !partial && !activity ? (
          <div className="assistant-activity">
            <span className="spin" />
            กำลังคิด… <span className="assistant-timer">{formatDuration(elapsed)}</span>
          </div>
        ) : null}
      </div>

      <footer className="assistant-compose">
        <div className="assistant-suggestions">
          {SUGGESTIONS.map((text) => (
            <button key={text} className="chip" disabled={streaming} onClick={() => void send(text)}>
              {text}
            </button>
          ))}
        </div>
        {previews.length ? (
          <div className="assistant-attachments">
            {previews.map((preview, i) => (
              <div key={preview.url} className="assistant-thumb">
                <button
                  type="button"
                  className="assistant-thumb-view"
                  aria-label={`ดูภาพลำดับที่ ${i + 1} เต็ม`}
                  onClick={() => openLightbox(previews.map((p) => p.url), i)}
                >
                  <img src={preview.url} alt={`ภาพแนบลำดับที่ ${i + 1}`} />
                </button>
                <button
                  type="button"
                  className="assistant-thumb-remove"
                  aria-label={`เอาภาพลำดับที่ ${i + 1} ออก`}
                  disabled={streaming}
                  onClick={() => setAttachments((current) => current.filter((_, n) => n !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <form
          className="assistant-input"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <input
            ref={filePicker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="assistant-attach"
            title="แนบภาพ (วางจากคลิปบอร์ดได้)"
            aria-label="แนบภาพ"
            disabled={streaming || attachments.length >= MAX_ATTACHMENTS}
            onClick={() => filePicker.current?.click()}
          >
            ⊕
          </button>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                addFiles(files);
              }
            }}
            placeholder={attachments.length ? "บอกเพิ่มได้ หรือกดส่งเลย" : "พิมพ์เพื่อให้ AI ช่วยจด"}
            disabled={streaming}
          />
          <button
            type="submit"
            disabled={streaming || (!draft.trim() && attachments.length === 0)}
            aria-label="ส่ง"
          >
            ↑
          </button>
        </form>
      </footer>

      {lightbox ? (
        <div
          className="assistant-lightbox"
          role="dialog"
          aria-label="ดูรูปเต็ม"
          onClick={() => setLightbox(null)}
        >
          {lightbox.urls.length > 1 ? (
            <button
              type="button"
              className="lightbox-nav prev"
              aria-label="รูปก่อนหน้า"
              onClick={(e) => {
                e.stopPropagation();
                stepLightbox(-1);
              }}
            >
              ‹
            </button>
          ) : null}
          <img
            src={lightbox.urls[lightbox.index]}
            alt="ภาพที่แนบ"
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.urls.length > 1 ? (
            <>
              <button
                type="button"
                className="lightbox-nav next"
                aria-label="รูปถัดไป"
                onClick={(e) => {
                  e.stopPropagation();
                  stepLightbox(1);
                }}
              >
                ›
              </button>
              <span className="lightbox-count mono">
                {lightbox.index + 1} / {lightbox.urls.length}
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
