import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let anthropicClient: Anthropic | null = null;
let geminiClient: GoogleGenAI | null = null;

export function isGeminiConfigured(): boolean {
  return config.ai.enabled && Boolean(process.env.GEMINI_API_KEY);
}

export function isAnthropicConfigured(): boolean {
  if (!config.ai.enabled) return false;
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const profileDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "anthropic")
    : path.join(os.homedir(), ".config", "anthropic");
  return fs.existsSync(profileDir);
}

/**
 * Checks if any AI credentials (Gemini or Anthropic) are available.
 */
export function credentialsAvailable(): boolean {
  return isGeminiConfigured() || isAnthropicConfigured();
}

/** True when AI routes can actually reach the API. */
export function aiReady(): boolean {
  return isGeminiConfigured() || isAnthropicConfigured();
}

export type AiProvider = "gemini" | "anthropic";

/** Whichever provider has credentials; Gemini wins when both are set. */
export function getAiProvider(): AiProvider {
  if (isGeminiConfigured()) return "gemini";
  return "anthropic";
}

/** The provider and model actually in use, or null when AI is unavailable. */
export function activeAiModel(): { provider: AiProvider; model: string } | null {
  if (!aiReady()) return null;
  const provider = getAiProvider();
  return { provider, model: provider === "gemini" ? GEMINI_MODEL : MODEL };
}

export function getGemini(): GoogleGenAI {
  if (!config.ai.enabled) {
    throw new AiUnavailableError("ผู้ช่วย AI ถูกปิดไว้ (AI_ENABLED=false)");
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new AiUnavailableError("ยังไม่ได้ตั้งค่า GEMINI_API_KEY บนเซิร์ฟเวอร์");
  }
  if (!geminiClient) {
    geminiClient = new GoogleGenAI(process.env.GEMINI_API_KEY ? { apiKey: process.env.GEMINI_API_KEY } : {});
  }
  return geminiClient;
}

export function anthropic(): Anthropic {
  if (!config.ai.enabled) {
    throw new AiUnavailableError("ผู้ช่วย AI ถูกปิดไว้ (AI_ENABLED=false)");
  }
  if (!isAnthropicConfigured()) {
    throw new AiUnavailableError(
      "ยังไม่ได้ตั้งค่าคีย์สำหรับผู้ช่วย AI — กำหนด ANTHROPIC_API_KEY บนเซิร์ฟเวอร์",
    );
  }
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

export class AiUnavailableError extends Error {}

export const MODEL = config.anthropic.model;
export const GEMINI_MODEL = config.gemini.model;

/** Maps SDK errors onto a message that is safe to show a user. */
export function describeAiError(error: unknown): { status: number; message: string } {
  if (error instanceof AiUnavailableError) {
    return { status: 503, message: error.message };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { status: 503, message: "ยังไม่ได้ตั้งค่า API Key สำหรับผู้ช่วย AI" };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return { status: 429, message: "ผู้ช่วย AI ใช้งานหนักอยู่ ลองอีกครั้งในอีกสักครู่" };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return { status: 400, message: `คำขอไม่ถูกต้อง: ${error.message}` };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return { status: 502, message: "เชื่อมต่อผู้ช่วย AI ไม่สำเร็จ" };
  }
  if (error instanceof Anthropic.APIError) {
    return { status: error.status ?? 502, message: `ผู้ช่วย AI ตอบกลับผิดพลาด: ${error.message}` };
  }
  const gemini = describeGeminiError(error);
  if (gemini) return gemini;

  return { status: 500, message: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
}

/**
 * Whether a failed call is worth trying again. Rate limits and 5xx/connection
 * blips are the provider having a bad second; auth, quota exhaustion and bad
 * requests will fail identically no matter how often we ask.
 */
export function isTransientAiError(error: unknown): boolean {
  if (error instanceof AiUnavailableError) return false;
  if (error instanceof Anthropic.AuthenticationError) return false;
  if (error instanceof Anthropic.BadRequestError) return false;
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.APIError) return (error.status ?? 0) >= 500;

  // Gemini and anything else surfaces as a plain Error carrying the status in
  // its text. Classify on that raw text — NOT on describeAiError's message,
  // which is written for the user: it renders every 429 as "โควต้าเต็ม", so
  // matching it would treat ordinary rate limits as permanent, and it maps a
  // bad API key to 503, which would make auth failures look retryable.
  if (!(error instanceof Error)) return false;
  const text = error.message;
  if (/API[_ ]?key|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b|\b403\b/i.test(text)) return false;
  // A hard quota ceiling is a 429 that retrying cannot clear.
  if (/RESOURCE_EXHAUSTED|exceeded your current quota|billing/i.test(text)) return false;
  if (/\b429\b|rate limit/i.test(text)) return true;
  if (/\b5\d{2}\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(text)) return true;
  return false;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt`, retrying transient provider failures with exponential backoff
 * and jitter. One flaky response used to lose the whole turn — including any
 * screenshots the user had attached, which they then had to pick again.
 */
export async function withAiRetry<T>(
  attempt: (tryIndex: number) => Promise<T>,
  options: { tries?: number; baseMs?: number; onRetry?: (info: { tryIndex: number; waitMs: number; error: unknown }) => void } = {},
): Promise<T> {
  const tries = options.tries ?? 3;
  const baseMs = options.baseMs ?? 700;
  let lastError: unknown;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await attempt(i);
    } catch (error) {
      lastError = error;
      if (i === tries - 1 || !isTransientAiError(error)) throw error;
      // Jitter keeps several stalled turns from retrying in lockstep.
      const waitMs = Math.round(baseMs * 2 ** i * (0.75 + Math.random() * 0.5));
      options.onRetry?.({ tryIndex: i, waitMs, error });
      await sleep(waitMs);
    }
  }
  throw lastError;
}

/**
 * The Gemini SDK reports failures as plain Errors carrying the HTTP status in
 * the message, so classify on that rather than letting a raw string through.
 */
function describeGeminiError(error: unknown): { status: number; message: string } | null {
  if (!(error instanceof Error)) return null;
  const text = error.message;
  const status = Number(/\b(4\d{2}|5\d{2})\b/.exec(text)?.[1] ?? 0);

  if (status === 401 || status === 403 || /API[_ ]?key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(text)) {
    return { status: 503, message: "คีย์ GEMINI_API_KEY ไม่ถูกต้อง หมดสิทธิ์ หรือยังไม่ได้ตั้งค่าบนเซิร์ฟเวอร์" };
  }
  if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(text)) {
    return { status: 429, message: "ผู้ช่วย AI โควต้าเต็มหรือใช้งานหนักอยู่ กรุณาลองใหม่ในอีกสักครู่" };
  }
  if (status === 404 || /not found|not supported|NOT_FOUND/i.test(text)) {
    return {
      status: 502,
      message: `ไม่พบโมเดล "${GEMINI_MODEL}" — กรุณาตรวจหรือแก้ไขค่า GEMINI_MODEL (เช่น gemini-2.5-flash หรือ gemini-3.7-flash) ใน .env`,
    };
  }
  if (status >= 500) {
    return { status: 502, message: "ผู้ช่วย AI ขัดข้องชั่วคราว ลองใหม่อีกครั้ง" };
  }
  if (status === 400) {
    return { status: 400, message: `คำขอไปยังผู้ช่วย AI ไม่ถูกต้อง: ${text}` };
  }
  return null;
}
