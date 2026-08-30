import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat } from "../lib/api.ts";
import { useToast } from "../lib/toast.tsx";
import { slotDef, type ChatMessage, type SlotId } from "../lib/types.ts";
import "../styles/assistant.css";

const SUGGESTIONS = ["สรุปทั้งวัน", "หาวันที่คล้ายกัน", "ตั้งสมมติฐาน"];

const TOOL_LABELS: Record<string, string> = {
  get_day: "กำลังอ่านบันทึกของวัน…",
  search_notes: "กำลังค้นบันทึกย้อนหลัง…",
  get_stats: "กำลังรวมตัวเลขย้อนหลัง…",
  save_note: "กำลังบันทึกลงโน้ต…",
};

type Props = {
  /** `global`, or a `YYYY-MM-DD` thread scoped to one day. */
  thread: string;
  slot?: SlotId;
  subtitle?: string;
  /** Called after the assistant writes into a note, so the page can refresh. */
  onNoteSaved?: (date: string, slot: SlotId) => void;
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [partial, setPartial] = useState("");
  const [activity, setActivity] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sentInitial = useRef(false);

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
      if (!message || streaming) return;

      setDraft("");
      setStreaming(true);
      setPartial("");
      setActivity(null);
      setMessages((current) => [
        ...current,
        {
          id: `local-${Date.now()}`,
          role: "user",
          content: message,
          meta: {},
          createdAt: new Date().toISOString(),
        },
      ]);

      let answer = "";
      const saved: Array<{ date: string; slot: SlotId }> = [];

      try {
        await streamChat({ message, thread, slot }, (event) => {
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
      if (answer.trim()) {
        setMessages((current) => [
          ...current,
          {
            id: `local-a-${Date.now()}`,
            role: "assistant",
            content: answer,
            meta: { savedNotes: saved },
            createdAt: new Date().toISOString(),
          },
        ]);
      }
    },
    [onNoteSaved, slot, streaming, thread, toast],
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

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="bubble user">
              <p>{message.content}</p>
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
            </div>
          ),
        )}

        {partial ? (
          <div className="bubble ai">
            <p>{partial}</p>
          </div>
        ) : null}

        {activity ? (
          <div className="assistant-activity">
            <span className="spin" />
            {activity}
          </div>
        ) : null}

        {streaming && !partial && !activity ? (
          <div className="assistant-activity">
            <span className="spin" />
            กำลังคิด…
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
        <form
          className="assistant-input"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="พิมพ์เพื่อให้ AI ช่วยจด"
            disabled={streaming}
          />
          <button type="submit" disabled={streaming || !draft.trim()} aria-label="ส่ง">
            ↑
          </button>
        </form>
      </footer>
    </div>
  );
}
