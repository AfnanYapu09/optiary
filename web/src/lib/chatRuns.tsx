import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { streamChat, type ChatStreamEvent } from "./api.ts";
import type { ChatStats, SlotId } from "./types.ts";

/**
 * In-flight assistant turns, held above the router.
 *
 * The panel used to own its own run, so navigating to another page unmounted it
 * mid-stream: the fetch kept going and the server still saved the answer, but
 * the user lost the live text and — if they came back before it landed — saw an
 * empty panel with no sign anything was happening. Keeping runs here means a
 * turn started on the capture page is still streaming when you walk over to the
 * chart page and back.
 */

export type RunState = {
  thread: string;
  /** Text streamed so far this turn. */
  partial: string;
  /** Label of the tool currently running, if any. */
  activity: string | null;
  startedAt: number;
  done: boolean;
  error: string | null;
  stats: ChatStats | null;
  /** Optimistic user turn, so the panel can show it before the reload. */
  echo: { content: string; previews: Array<{ url: string; mime: string }> } | null;
};

/** (date, slot) pairs the run wrote to, so pages can refresh what changed. */
export type DataChange = { date: string; slot: SlotId | undefined };

type Ctx = {
  runs: Record<string, RunState>;
  start: (input: {
    thread: string;
    message: string;
    slot?: SlotId;
    files?: File[];
    onEvent?: (event: ChatStreamEvent) => void;
  }) => Promise<void>;
  /** Aborts a run on the user's say-so. Navigating away deliberately does not. */
  stop: (thread: string) => void;
  /** Clears a finished run once the panel has folded it into the transcript. */
  clear: (thread: string) => void;
  /** Fires whenever a tool wrote data, wherever the user currently is. */
  onDataChange: (listener: (change: DataChange) => void) => () => void;
};

const ChatRunsContext = createContext<Ctx | null>(null);

export function ChatRunsProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const listeners = useRef(new Set<(change: DataChange) => void>());
  const aborters = useRef(new Map<string, AbortController>());
  /** Threads with a turn in flight, so the guard never reads stale state. */
  const active = useRef(new Set<string>());

  const patch = useCallback((thread: string, next: Partial<RunState>) => {
    setRuns((current) => {
      const existing = current[thread];
      if (!existing) return current;
      return { ...current, [thread]: { ...existing, ...next } };
    });
  }, []);

  const onDataChange = useCallback((listener: (change: DataChange) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const emit = useCallback((change: DataChange) => {
    for (const listener of listeners.current) listener(change);
  }, []);

  const clear = useCallback((thread: string) => {
    setRuns((current) => {
      if (!current[thread]) return current;
      const { [thread]: _gone, ...rest } = current;
      return rest;
    });
  }, []);

  const start = useCallback<Ctx["start"]>(
    async ({ thread, message, slot, files, onEvent }) => {
      // One run per thread. Tracked in a ref rather than read off `runs`: state
      // read through the closure is a snapshot, so two sends in the same tick
      // both saw "nothing running" and the second overwrote the first's aborter,
      // leaving a turn nobody could stop. Keeping `runs` out of the dependencies
      // also stops this callback — and every `send` built on it — being rebuilt
      // on each streamed chunk.
      if (active.current.has(thread)) return;
      active.current.add(thread);

      const previews = (files ?? []).map((file) => ({
        url: URL.createObjectURL(file),
        mime: file.type,
      }));

      setRuns((current) => ({
        ...current,
        [thread]: {
          thread,
          partial: "",
          activity: null,
          startedAt: Date.now(),
          done: false,
          error: null,
          stats: null,
          echo: {
            content: message || (files?.length ? "ช่วยอ่านภาพนี้แล้วจดให้หน่อย" : ""),
            previews,
          },
        },
      }));

      const aborter = new AbortController();
      aborters.current.set(thread, aborter);

      let answer = "";
      try {
        await streamChat({ message, thread, slot, files }, (event) => {
          onEvent?.(event);
          switch (event.type) {
            case "text":
              answer += event.text;
              patch(thread, { partial: answer, activity: null });
              break;
            case "tool":
              patch(thread, { activity: TOOL_LABELS[event.name] ?? "กำลังค้นข้อมูล…" });
              break;
            case "note-saved":
            case "shot-saved":
            case "metrics-saved":
              emit({ date: event.date, slot: event.slot });
              break;
            case "data-changed":
              emit({ date: event.date ?? thread, slot: event.slot });
              break;
            case "settings-changed":
              emit({ date: thread, slot: undefined });
              break;
            case "done":
              patch(thread, { stats: event.stats });
              break;
            case "error":
              patch(thread, { error: event.message });
              break;
            default:
              break;
          }
        }, aborter.signal);
      } catch (error) {
        // An abort is the user's own doing, not a failure to report.
        const stopped = error instanceof DOMException && error.name === "AbortError";
        if (!stopped) {
          patch(thread, { error: error instanceof Error ? error.message : "แชทล้มเหลว" });
        }
      }

      active.current.delete(thread);
      aborters.current.delete(thread);
      previews.forEach((p) => URL.revokeObjectURL(p.url));
      // `echo` is deliberately kept until the panel calls `clear`. It is the only
      // remaining copy of what the user asked, and the panel needs it to rebuild
      // the turn locally if reloading the transcript fails.
      patch(thread, { done: true, activity: null });
    },
    [emit, patch],
  );

  const stop = useCallback((thread: string) => {
    aborters.current.get(thread)?.abort();
  }, []);

  const value = useMemo<Ctx>(() => ({ runs, start, stop, clear, onDataChange }), [
    clear,
    onDataChange,
    runs,
    start,
    stop,
  ]);

  return <ChatRunsContext.Provider value={value}>{children}</ChatRunsContext.Provider>;
}

export const TOOL_LABELS: Record<string, string> = {
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
  resolve_date: "กำลังตรวจสอบปีของวันที่…",
  set_gamma: "กำลังประเมิน gamma ของวัน…",
  update_settings: "กำลังปรับตั้งค่า…",
  delete_data: "กำลังจัดการลบข้อมูล…",
};

export function useChatRuns(): Ctx {
  const ctx = useContext(ChatRunsContext);
  if (!ctx) throw new Error("useChatRuns must be used inside <ChatRunsProvider>");
  return ctx;
}

/** The live run for one thread, or null when nothing is in flight for it. */
export function useChatRun(thread: string): RunState | null {
  return useChatRuns().runs[thread] ?? null;
}

/** Subscribes to writes made by any run, including ones started on another page. */
export function useDataChange(listener: (change: DataChange) => void): void {
  const { onDataChange } = useChatRuns();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => onDataChange((change) => ref.current(change)), [onDataChange]);
}
