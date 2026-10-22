// One-line console log with a timestamp (the server and the recorder), and the host clock in seconds.

export function log(msg: string): void {
  const t = new Date(), p = (n: number) => String(n).padStart(2, "0");
  console.log(`[${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}] ${msg}`);
}

/** host time (unix s) with sub-millisecond resolution: telegram receive times for the clock sync */
export const nowS = (): number => (performance.timeOrigin + performance.now()) / 1000;

/** local time as YYYYmmdd_HHMMSS (recording names) */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
