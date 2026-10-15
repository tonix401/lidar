// Theme: "dark" (default), "light", or "system" (follows the OS). The colours live as CSS variables on
// :root (styles.css); canvas and WebGL drawing read them through themeColors().
import type { ThemeColors } from "../core/types";

export type Theme = "system" | "dark" | "light";
export type { ThemeColors };

export function applyTheme(t: Theme, root: HTMLElement = document.documentElement): void { root.dataset.theme = t; }

/** the current theme's colours (as CSS colour strings) */
export function themeColors(root: HTMLElement = document.documentElement): ThemeColors {
  const cs = getComputedStyle(root), v = (n: string, fallback: string) => cs.getPropertyValue("--" + n).trim() || fallback;
  return { bg: v("bg", "#0e1116"), border: v("border", "#2a313c"), text: v("text", "#d7dde5"), muted: v("muted", "#8b95a3"),
           accent: v("accent", "#4aa3ff"), warn: v("warn", "#d29922"), grid: v("grid", "#262d37"), grid2: v("grid2", "#3d4654"),
           axis: v("axis", "#6e7887"), mark: v("mark", "#ffd33d"), field: v("field", "#0d1117") };
}

/** "#rrggbb" → [0..1]×3 (null for anything else) */
export function hexRGB(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex.trim());
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
}

/** call `fn` when the OS switches between light and dark (matters for "system") */
export function onSystemThemeChange(fn: () => void): void {
  try { matchMedia("(prefers-color-scheme: light)").addEventListener("change", fn); } catch { /* old browser / jsdom */ }
}
