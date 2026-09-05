import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, chatImageUrl } from "../lib/api.ts";
import Markdown from "./Markdown.tsx";
import { useSession } from "../lib/session.tsx";
import { useToast } from "../lib/toast.tsx";
import { saveChatMessageToCloud } from "../lib/firebase.ts";
import { useChatRun, useChatRuns } from "../lib/chatRuns.tsx";
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

const PlusIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M9 10L4 15l5 5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M4 15h11a5 5 0 0 0 5-5V4"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const StopIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" />
  </svg>
);

const RetryIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M20 11A8 8 0 1 0 18 16.5"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <path d="M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M4 20h4L19 9a2.5 2.5 0 0 0-4-4L4 16v4Z"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  </svg>
);

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="2" />
    <path
      d="M5 15V6a2 2 0 0 1 2-2h8"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
);

/** "z-ai/glm-5.3-flash" -> "GLM 5.3 Flash" · "gemini-3.6-flash" -> "Gemini 3.6 Flash" */
function prettyModel(model: string): string {
  const tail = model.split("/").pop() ?? model;
  return tail
    .split(/[-_]/)
    .map((w) =>
      /^[a-z]{2,3}$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

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
  const { user, config } = useSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [elapsed, setElapsed] = useState(0);
  // Which user turn is open for editing, and the text being edited in it.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** The transcript could not be loaded — distinct from the thread being empty. */
  const [historyFailed, setHistoryFailed] = useState(false);

  // The turn itself lives above the router, so leaving this page mid-answer no
  // longer cancels it — coming back re-attaches to the same live stream.
  const { start, stop, clear } = useChatRuns();
  const run = useChatRun(thread);
  const streaming = Boolean(run && !run.done);
  // Read inside the completion effect without making the run object a dependency,
  // which would re-run it on every streamed chunk.
  const runRef = useRef(run);
  runRef.current = run;
  const partial = run?.partial ?? "";
  const activity = run?.activity ?? null;
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
  const textarea = useRef<HTMLTextAreaElement>(null);
  const sentInitial = useRef(false);
  // The optimistic user bubble belongs only to the panel that pressed send. A
  // panel mounted later loads the turn from the transcript instead — the server
  // persists it before streaming — so showing the echo there would double it.
  const ownsEcho = useRef(false);

  // Auto-grow the composer like Claude's, capped so it never eats the thread.
  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  // A ticking "…12.3 วิ" while the model works, so a slow reply doesn't look
  // hung. Counted from the run's own start so the timer stays honest when the
  // panel is remounted part-way through a turn.
  useEffect(() => {
    if (!run || run.done) return;
    const startedAt = run.startedAt;
    setElapsed(Date.now() - startedAt);
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 200);
    return () => clearInterval(t);
  }, [run]);

  const addFiles = useCallback(
    (incoming: File[]) => {
      const images = incoming.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      setAttachments((current) => [...current, ...images]);
    },
    [],
  );

  // Every screenshot rides inline in one model request, so a very large batch
  // is worth flagging before it is sent rather than failing at the provider.
  const batchBytes = useMemo(() => attachments.reduce((n, f) => n + f.size, 0), [attachments]);

  // Object URLs are revoked on replacement so previews don't leak between turns.
  const previews = useMemo(
    () => attachments.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [attachments],
  );
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  /**
   * Loads a thread, retrying a couple of times before giving up.
   *
   * A failure must never clear what is on screen. This used to `setMessages([])`
   * on any rejection, so one blip — a sleeping instance waking, a token being
   * refreshed — emptied the panel and the conversation looked like it had reset
   * itself to a new chat, even though the server still had every message.
   */
  const loadThread = useCallback(
    async (target: string, isCurrent: () => boolean): Promise<boolean> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await api.chatHistory(target);
          if (isCurrent()) {
            setMessages(res.messages);
            setHistoryFailed(false);
          }
          return true;
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
      // Say so rather than sitting there empty. An unexplained blank panel is
      // indistinguishable from a fresh conversation, which is exactly the wrong
      // thing to imply about a thread whose messages are still on the server.
      if (isCurrent()) setHistoryFailed(true);
      return false;
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    // Switching threads is the one time the old messages must go: they belong to
    // a different conversation, so showing them while this one loads would be wrong.
    setMessages([]);
    void loadThread(thread, () => alive);
    return () => {
      alive = false;
    };
  }, [loadThread, thread]);

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
      ownsEcho.current = true;
      if (user?.id) {
        void saveChatMessageToCloud(user.id, "user", message || "[แนบภาพ]");
      }

      let answer = "";
      await start({
        thread,
        message,
        slot,
        files,
        onEvent: (event) => {
          if (event.type === "text") answer += event.text;
          if (event.type === "error") toast(event.message, "err");
          // The page behind the panel refreshes whatever the run wrote. These
          // still fire here (not only through the store) so the panel's own
          // page updates even when it is the only listener.
          if (
            event.type === "note-saved" ||
            event.type === "shot-saved" ||
            event.type === "metrics-saved"
          ) {
            onNoteSaved?.(event.date, event.slot);
          }
          if (event.type === "data-changed") onNoteSaved?.(event.date ?? thread, event.slot ?? slot);
          if (event.type === "settings-changed") onNoteSaved?.(thread, slot);
        },
      });

      if (answer.trim() && user?.id) {
        void saveChatMessageToCloud(user.id, "assistant", answer);
      }
    },
    [attachments, onNoteSaved, slot, start, streaming, thread, toast, user?.id],
  );

  // When a run finishes — whether or not this panel was mounted for it — pull
  // the canonical transcript so the user turn gets real attachment ids and the
  // assistant turn carries its saved stats, then drop the finished run.
  //
  // Clearing the run is what removes the optimistic bubble and the streamed text
  // from the screen, so it must not happen until the turn is safely somewhere
  // else. It used to run in a `finally`: when the reload failed, the just-finished
  // exchange disappeared and the panel looked like a brand-new chat. Now a failed
  // reload rebuilds the turn from the run itself before letting go of it.
  useEffect(() => {
    if (!run?.done) return;
    let alive = true;

    void (async () => {
      const reloaded = await loadThread(thread, () => alive);
      if (!alive) return;

      const finished = runRef.current;
      if (!reloaded && finished) {
        const at = new Date(finished.startedAt).toISOString();
        const rebuilt: ChatMessage[] = [];
        if (finished.echo?.content) {
          rebuilt.push({
            id: `local-user-${finished.startedAt}`,
            role: "user",
            content: finished.echo.content,
            meta: {},
            createdAt: at,
          });
        }
        if (finished.partial.trim()) {
          rebuilt.push({
            id: `local-assistant-${finished.startedAt}`,
            role: "assistant",
            content: finished.partial,
            meta: finished.stats ? { stats: finished.stats } : {},
            createdAt: new Date().toISOString(),
          });
        }
        if (rebuilt.length) setMessages((current) => [...current, ...rebuilt]);
      }

      ownsEcho.current = false;
      clear(thread);
    })();

    return () => {
      alive = false;
    };
  }, [clear, loadThread, run?.done, thread]);

  useEffect(() => {
    if (initialQuestion && !sentInitial.current) {
      sentInitial.current = true;
      void send(initialQuestion);
    }
  }, [initialQuestion, send]);

  const copyMessage = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast("คัดลอกแล้ว", "ok");
      } catch {
        toast("คัดลอกไม่สำเร็จ", "err");
      }
    },
    [toast],
  );

  /**
   * Replays the thread from `messageId` with `text` as the question — the shared
   * path behind both editing a turn and retrying it.
   *
   * The old turn and everything after it is dropped first: the replies below it
   * were answering the previous wording, so keeping them would leave the
   * transcript self-contradicting and feed that contradiction back as history.
   */
  const resendFrom = useCallback(
    async (messageId: string, text: string) => {
      const question = text.trim();
      if (!question || streaming) return;

      const previous = messages;
      const cut = messages.findIndex((m) => m.id === messageId);
      if (cut >= 0) setMessages(messages.slice(0, cut));
      setEditingId(null);

      try {
        await api.truncateChatFrom(thread, messageId);
      } catch {
        setMessages(previous);
        toast("ย้อนประวัติแชทไม่สำเร็จ", "err");
        return;
      }
      await send(question);
    },
    [messages, send, streaming, thread, toast],
  );

  return (
    <div className="assistant">
      <header className="assistant-head">
        <span className="diamond" style={{ width: 13, height: 13 }} />
        <span className="assistant-head-title" title={subtitle}>
          ผู้ช่วยวิจัย
        </span>
        {slot ? (
          <span className="mono" style={{ fontSize: 10, color: "var(--t-30)" }}>
            {slotDef(slot).th}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
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
        {messages.length === 0 && !streaming && historyFailed ? (
          <div className="assistant-welcome">
            <span className="diamond" aria-hidden="true" />
            <h2>โหลดประวัติแชทไม่สำเร็จ</h2>
            <p>ข้อความเก่ายังอยู่บนเซิร์ฟเวอร์ ไม่ได้หายไปไหน</p>
            <button
              className="chip"
              onClick={() => {
                setHistoryFailed(false);
                void loadThread(thread, () => true);
              }}
            >
              ลองอีกครั้ง
            </button>
          </div>
        ) : null}

        {messages.length === 0 && !streaming && !historyFailed ? (
          <div className="assistant-welcome">
            <span className="diamond" aria-hidden="true" />
            <h2>วันนี้อยากให้ช่วยอะไรครับ</h2>
            <p>แนบภาพ OI ได้เลย หรือถามจากบันทึกเก่าก็ได้</p>
          </div>
        ) : null}

        {messages.map((message) => {
          const shots = (message.meta?.attachments ?? [])
            .map((a) => a.url ?? (a.id ? chatImageUrl(a.id) : null))
            .filter((u): u is string => Boolean(u));
          return message.role === "user" ? (
            <div key={message.id} className="turn user">
              {editingId === message.id ? (
                <div className="bubble user editing">
                  <textarea
                    className="bubble-edit"
                    value={editDraft}
                    autoFocus
                    rows={Math.min(10, editDraft.split("\n").length + 1)}
                    onChange={(event) => setEditDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingId(null);
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void resendFrom(message.id, editDraft);
                      }
                    }}
                  />
                  {shots.length ? (
                    <p className="bubble-edit-note">
                      ภาพที่แนบมาเดิม {shots.length} ภาพจะไม่ถูกส่งไปด้วย
                    </p>
                  ) : null}
                  <div className="bubble-edit-row">
                    <button type="button" className="chip" onClick={() => setEditingId(null)}>
                      ยกเลิก
                    </button>
                    <button
                      type="button"
                      className="chip gold"
                      disabled={!editDraft.trim() || streaming}
                      onClick={() => void resendFrom(message.id, editDraft)}
                    >
                      ส่งใหม่
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="bubble user">
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
                  <div className="turn-actions">
                    <button
                      type="button"
                      className="turn-action"
                      title="ส่งคำถามนี้ใหม่"
                      aria-label="ส่งคำถามนี้ใหม่"
                      disabled={streaming || !message.content}
                      onClick={() => void resendFrom(message.id, message.content)}
                    >
                      <RetryIcon />
                    </button>
                    <button
                      type="button"
                      className="turn-action"
                      title="แก้ไขแล้วส่งใหม่"
                      aria-label="แก้ไขแล้วส่งใหม่"
                      disabled={streaming}
                      onClick={() => {
                        setEditDraft(message.content);
                        setEditingId(message.id);
                      }}
                    >
                      <EditIcon />
                    </button>
                    <button
                      type="button"
                      className="turn-action"
                      title="คัดลอกข้อความ"
                      aria-label="คัดลอกข้อความ"
                      onClick={() => void copyMessage(message.content)}
                    >
                      <CopyIcon />
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div key={message.id} className="turn ai">
              <span className="turn-glyph diamond" aria-hidden="true" />
              <div className="turn-body">
                <Markdown text={message.content} />
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
                <div className="turn-actions">
                  <button
                    type="button"
                    className="turn-action"
                    title="คัดลอกคำตอบ"
                    aria-label="คัดลอกคำตอบ"
                    onClick={() => void copyMessage(message.content)}
                  >
                    <CopyIcon />
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {/* Optimistic user turn for the run in flight. It lives on the run, not
            in local state, so it is still shown after navigating back. */}
        {run?.echo && ownsEcho.current ? (
          <div className="turn user">
            <div className="bubble user">
              {run.echo.previews.length ? (
                <div className="bubble-shots">
                  {run.echo.previews.map((preview, i) => (
                    <button
                      key={preview.url}
                      type="button"
                      className="bubble-shot"
                      onClick={() => openLightbox(run.echo!.previews.map((p) => p.url), i)}
                      aria-label="ดูรูปเต็ม"
                    >
                      <img src={preview.url} alt="ภาพที่แนบ" />
                    </button>
                  ))}
                </div>
              ) : null}
              {run.echo.content ? <p>{run.echo.content}</p> : null}
            </div>
          </div>
        ) : null}

        {partial ? (
          <div className="turn ai">
            <span className="turn-glyph diamond" aria-hidden="true" />
            <div className="turn-body">
              <Markdown text={partial} />
            </div>
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
        {messages.length === 0 && !streaming ? (
          <div className="assistant-suggestions">
            {SUGGESTIONS.map((text) => (
              <button
                key={text}
                className="chip"
                disabled={streaming}
                onClick={() => void send(text)}
              >
                {text}
              </button>
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
          {attachments.length > 2 ? (
            <div className="assistant-batch">
              <b>{attachments.length}</b> ภาพ · <b>{(batchBytes / 1024 / 1024).toFixed(1)} MB</b>
              {batchBytes > 25 * 1024 * 1024 ? (
                <span className="warn">— ชุดใหญ่มาก อาจใช้เวลานานหรือเกินขีดจำกัดของโมเดล</span>
              ) : null}
              <button type="button" className="ghost" disabled={streaming} onClick={() => setAttachments([])}>
                เอาออกทั้งหมด
              </button>
            </div>
          ) : null}
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
          <div className="assistant-input-row">
            <button
              type="button"
              className="assistant-attach"
              title="แนบภาพ (วางจากคลิปบอร์ดได้)"
              aria-label="แนบภาพ"
              disabled={streaming}
              onClick={() => filePicker.current?.click()}
            >
              <PlusIcon />
            </button>
            <textarea
              ref={textarea}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send(draft);
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length) {
                  event.preventDefault();
                  addFiles(files);
                }
              }}
              placeholder={attachments.length ? "บอกเพิ่มได้ หรือกดส่งเลย" : "เขียนข้อความ…"}
              disabled={streaming}
            />
            {/* While a turn is running the same slot becomes a stop control —
                the square is the one gesture people already read as "halt". */}
            {streaming ? (
              <button
                type="button"
                className="assistant-send stopping"
                onClick={() => stop(thread)}
                title="หยุดคำตอบ"
                aria-label="หยุด"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="submit"
                className="assistant-send"
                disabled={!draft.trim() && attachments.length === 0}
                aria-label="ส่ง"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </form>

        <div className="assistant-disclaimer">
          <span>ผู้ช่วยเป็น AI อาจตอบพลาดได้ ตรวจสอบข้อมูลสำคัญอีกครั้ง</span>
          {config?.aiModel ? (
            <span className="assistant-model">{prettyModel(config.aiModel.model)}</span>
          ) : null}
        </div>
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
