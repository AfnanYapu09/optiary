/**
 * Light / dark theme + accent tone, stored per-browser (not synced). Applied to
 * <html> via data-theme / data-accent, which app.css keys all its tokens off.
 */

export type ThemeMode = "light" | "dark" | "system";
export type Accent = "gold" | "sage" | "slate" | "clay";

export const ACCENTS: Array<{ id: Accent; label: string; swatch: string }> = [
  { id: "gold", label: "ทอง", swatch: "#9a6c1f" },
  { id: "sage", label: "เขียวเสจ", swatch: "#4a785c" },
  { id: "slate", label: "น้ำเงินหิน", swatch: "#4a689e" },
  { id: "clay", label: "ดินเผา", swatch: "#a65c3e" },
];

const THEME_KEY = "optiary_theme";
const ACCENT_KEY = "optiary_accent";

const prefersDark = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(THEME_KEY);
  return v === "dark" || v === "light" || v === "system" ? v : "dark";
}

export function getAccent(): Accent {
  const v = localStorage.getItem(ACCENT_KEY);
  return v === "sage" || v === "slate" || v === "clay" ? v : "gold";
}

/** Writes data-theme / data-accent onto <html> from the current stored prefs. */
export function applyTheme(): void {
  const root = document.documentElement;
  const mode = getThemeMode();
  const dark = mode === "dark" || (mode === "system" && prefersDark());
  if (dark) root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");

  const accent = getAccent();
  if (accent === "gold") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0d1014" : "#fffffe");
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(THEME_KEY, mode);
  applyTheme();
}

export function setAccent(accent: Accent): void {
  localStorage.setItem(ACCENT_KEY, accent);
  applyTheme();
}

// Keep "system" mode live when the OS theme flips.
if (typeof matchMedia === "function") {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getThemeMode() === "system") applyTheme();
  });
}
