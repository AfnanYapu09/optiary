import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client: Anthropic | null = null;

/**
 * The SDK resolves credentials lazily and fails at request time with an opaque
 * message, so we check the same sources up front to give a usable answer.
 */
export function credentialsAvailable(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true;
  const profileDir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "anthropic")
    : path.join(os.homedir(), ".config", "anthropic");
  return fs.existsSync(profileDir);
}

/** True when AI routes can actually reach the API. */
export function aiReady(): boolean {
  return config.anthropic.enabled && credentialsAvailable();
}

export function anthropic(): Anthropic {
  if (!config.anthropic.enabled) {
    throw new AiUnavailableError("ผู้ช่วย AI ถูกปิดไว้ (AI_ENABLED=false)");
  }
  if (!credentialsAvailable()) {
    throw new AiUnavailableError(
      "ยังไม่ได้ตั้งค่าคีย์สำหรับผู้ช่วย AI — กำหนด ANTHROPIC_API_KEY บนเซิร์ฟเวอร์",
    );
  }
  if (!client) client = new Anthropic();
  return client;
}

export class AiUnavailableError extends Error {}

export const MODEL = config.anthropic.model;

/** Maps SDK errors onto a message that is safe to show a user. */
export function describeAiError(error: unknown): { status: number; message: string } {
  if (error instanceof AiUnavailableError) {
    return { status: 503, message: error.message };
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return { status: 503, message: "ยังไม่ได้ตั้งค่า ANTHROPIC_API_KEY สำหรับผู้ช่วย AI" };
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
  return { status: 500, message: error instanceof Error ? error.message : "เกิดข้อผิดพลาด" };
}
