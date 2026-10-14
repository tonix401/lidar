export const fmtTime = (s: number | undefined): string => {
  const v = Math.max(0, Math.round(s || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};

export const fmtMB = (bytes: number): string => (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0) + " MB";

/** first line of an error, capped — for console and panel messages */
export const shortError = (e: unknown, max = 160): string =>
  String((e instanceof Error ? e.message : e) ?? "").split("\n")[0].slice(0, max);
