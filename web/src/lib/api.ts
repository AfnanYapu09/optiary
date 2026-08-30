import type {
  CalendarDay,
  ChatMessage,
  CompareResult,
  DayRecord,
  EntryRecord,
  ImageKind,
  ImageRecord,
  LibraryItem,
  Metrics,
  SlotId,
  Stats,
  Streak,
  User,
  UserSettings,
} from "./types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "include", ...init });
  if (!res.ok) {
    let message = `คำขอล้มเหลว (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

export const api = {
  authConfig: () => request<{ google: boolean; devLogin: boolean; ai: boolean }>("/auth/config"),
  me: () => request<{ user: User }>("/me"),
  firebaseLogin: (profile: { sub?: string; uid?: string; email: string; name?: string; picture?: string; idToken?: string }) =>
    request<{ user: User }>("/auth/firebase-login", json("POST", profile)),
  devLogin: (email?: string, name?: string) =>
    request<{ user: User }>("/auth/dev-login", json("POST", { email, name })),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),

  calendar: (month: string) =>
    request<{ month: string; days: CalendarDay[]; streak: Streak }>(`/calendar?month=${month}`),
  day: (date: string) => request<DayRecord>(`/days/${date}`),
  saveEntry: (date: string, slot: SlotId, patch: { note?: string; tags?: string[]; metrics?: Metrics }) =>
    request<EntryRecord>(`/days/${date}/${slot}`, json("PUT", patch)),

  uploadImage: async (date: string, slot: SlotId, kind: ImageKind, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/images/${date}/${slot}/${kind}`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
    if (!res.ok) {
      let message = `อัปโหลดไม่สำเร็จ (${res.status})`;
      try {
        const body = await res.json();
        if (typeof body?.error === "string") message = body.error;
      } catch {
        /* keep generic message */
      }
      throw new ApiError(res.status, message);
    }
    return (await res.json()) as {
      image: ImageRecord;
      extraction: { ok: true } | { ok: false; message: string } | null;
      day: DayRecord;
    };
  },
  deleteImage: (id: string) => request<{ ok: true }>(`/images/${id}`, { method: "DELETE" }),
  extract: (date: string, slot: SlotId) =>
    request<{ entry: EntryRecord; confidence: string }>(`/extract/${date}/${slot}`, { method: "POST" }),

  library: (kind?: ImageKind) =>
    request<{ items: LibraryItem[] }>(`/library${kind ? `?kind=${kind}` : ""}`),
  compare: (left: string, right: string) =>
    request<CompareResult>(`/compare?left=${left}&right=${right}`),
  stats: (days: number) => request<Stats>(`/stats?days=${days}`),

  settings: () => request<{ settings: UserSettings }>("/settings"),
  saveSettings: (settings: UserSettings) =>
    request<{ settings: UserSettings }>("/settings", json("PUT", { settings })),

  chatHistory: (thread: string) =>
    request<{ thread: string; messages: ChatMessage[] }>(`/chat/${thread}`),
  clearChat: (thread: string) => request<{ ok: true }>(`/chat/${thread}`, { method: "DELETE" }),
};

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "note-saved"; date: string; slot: SlotId }
  | { type: "done"; text: string }
  | { type: "error"; message: string }
  | { type: "end" };

/**
 * POSTs a chat turn and consumes the SSE reply, invoking `onEvent` per frame.
 * Rejects only on transport failures — model-side problems arrive as `error` events.
 */
export async function streamChat(
  body: { message: string; thread: string; slot?: SlotId },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "include",
    signal,
  });
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, `แชทล้มเหลว (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          onEvent(JSON.parse(line.slice(6)) as ChatStreamEvent);
        } catch {
          /* ignore a malformed frame rather than aborting the stream */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}
