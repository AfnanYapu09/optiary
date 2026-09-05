import type {
  CalendarDay,
  ChatMessage,
  ChatStats,
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
import type { AuthConfig } from "./types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TOKEN_KEY = "optiary_token";

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* ignore storage errors */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const res = await fetch(`/api${path}`, { credentials: "include", ...init, headers });
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

/**
 * Collapses identical GETs that are in flight at the same moment into one
 * request. Two components can legitimately want the same data on the same
 * render — the shell and the home page both need the dataset totals — and
 * without this each mount fires its own copy.
 *
 * Only concurrent calls share; once a request settles the entry is dropped, so
 * nothing is ever served from a stale cache after a write.
 */
const inFlight = new Map<string, Promise<unknown>>();

function shared<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

export const api = {
  authConfig: () => shared("auth/config", () => request<AuthConfig>("/auth/config")),
  me: () => shared("me", () => request<{ user: User; token?: string }>("/me")),
  /** The server derives the identity from the ID token; nothing else is trusted. */
  firebaseLogin: async (idToken: string) => {
    const res = await request<{ user: User; token?: string; slots?: any }>(
      "/auth/firebase-login",
      json("POST", { idToken }),
    );
    if (res.token) setStoredToken(res.token);
    return res;
  },
  devLogin: async (email?: string, name?: string) => {
    const res = await request<{ user: User; token?: string }>(
      "/auth/dev-login",
      json("POST", { email, name }),
    );
    if (res.token) setStoredToken(res.token);
    return res;
  },
  logout: async () => {
    setStoredToken(null);
    return request<{ ok: true }>("/auth/logout", { method: "POST" });
  },

  calendar: (month: string) =>
    shared(`calendar:${month}`, () =>
      request<{ month: string; days: CalendarDay[]; streak: Streak }>(`/calendar?month=${month}`),
    ),
  day: (date: string) => shared(`day:${date}`, () => request<DayRecord>(`/days/${date}`)),
  saveEntry: (date: string, slot: SlotId, patch: { note?: string; tags?: string[]; metrics?: Metrics }) =>
    request<EntryRecord>(`/days/${date}/${slot}`, json("PUT", patch)),

  uploadImage: async (date: string, slot: SlotId, kind: ImageKind, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const token = getStoredToken();
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    const res = await fetch(`/api/images/${date}/${slot}/${kind}`, {
      method: "POST",
      body: form,
      headers,
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
  stats: (days: number) => shared(`stats:${days}`, () => request<Stats>(`/stats?days=${days}`)),

  settings: () => request<{ settings: UserSettings }>("/settings"),
  saveSettings: (settings: UserSettings) =>
    request<{ settings: UserSettings }>("/settings", json("PUT", { settings })),

  chatHistory: (thread: string) =>
    request<{ thread: string; messages: ChatMessage[] }>(`/chat/${thread}`),
  clearChat: (thread: string) => request<{ ok: true }>(`/chat/${thread}`, { method: "DELETE" }),
  /** Drops `messageId` and every turn after it — used before an edit or a retry. */
  truncateChatFrom: (thread: string, messageId: string) =>
    request<{ ok: true; removed: number }>(`/chat/${thread}/from/${messageId}`, {
      method: "DELETE",
    }),
};

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string }
  | { type: "note-saved"; date: string; slot: SlotId }
  | { type: "shot-saved"; date: string; slot: SlotId; kind: ImageKind }
  | { type: "metrics-saved"; date: string; slot: SlotId }
  | { type: "data-changed"; date?: string; slot?: SlotId }
  | { type: "settings-changed" }
  | { type: "done"; text: string; stats: ChatStats }
  | { type: "error"; message: string }
  | { type: "end" };

/** URL that serves an image the user attached to a chat turn. */
export const chatImageUrl = (id: string) => `/api/chat-image/${id}/file`;

/**
 * POSTs a chat turn and consumes the SSE reply, invoking `onEvent` per frame.
 * Rejects only on transport failures — model-side problems arrive as `error` events.
 */
export async function streamChat(
  body: { message: string; thread: string; slot?: SlotId; files?: File[] },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getStoredToken();
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;

  // Attachments force multipart; without them JSON keeps the request small.
  let payload: BodyInit;
  if (body.files?.length) {
    const form = new FormData();
    form.append("message", body.message);
    form.append("thread", body.thread);
    if (body.slot) form.append("slot", body.slot);
    for (const file of body.files) form.append("files", file);
    payload = form;
  } else {
    headers["content-type"] = "application/json";
    payload = JSON.stringify({ message: body.message, thread: body.thread, slot: body.slot });
  }

  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: payload,
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
