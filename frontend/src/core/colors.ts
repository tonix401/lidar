import type { RGB } from "./types";

/** turbo colormap (Google, polynomial approximation), t in 0..1 */
export function turbo(t: number): RGB {
  t = Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.61539260 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.10667330 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(r), c(g), c(b)];
}

export function turboGradientCss(stops = 11): string {
  return "linear-gradient(90deg," + Array.from({ length: stops }, (_, i) => css(turbo(i / (stops - 1)))).join(",") + ")";
}

export function hsl2rgb(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

/** distinct colours for consecutive ids (golden-ratio hue steps) */
export const trackColor = (id: number): RGB => hsl2rgb((id * 0.618033988749895 + 0.05) % 1, 0.85, 0.58);

export const css = (c: RGB, alpha = 1): string =>
  alpha < 1 ? `rgba(${c.map(v => Math.round(v * 255)).join(",")},${alpha})` : `rgb(${c.map(v => Math.round(v * 255)).join(",")})`;

export const scale = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];

/** RGBA packed for a Uint32Array view of ImageData (little endian: ABGR) */
export const packABGR = (c: RGB): number =>
  (0xff000000 | (Math.round(c[2] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[0] * 255)) >>> 0;

export const AREA_COLORS: RGB[] = [[0.29, 0.64, 1.0], [0.25, 0.73, 0.31], [0.97, 0.32, 0.29]];   // flat · detail · moving
