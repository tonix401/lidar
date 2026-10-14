// Active problems (server unreachable, sensor down, processing error, failed action): one short console
// line when a problem starts or changes and one when it clears — never one per retry.
import { shortError } from "../core/format";

export type ProblemName = "server" | "sensor" | "replay" | "processing" | "action";

const PANEL_TEXT: Partial<Record<ProblemName, (msg: string) => string>> = {
  server: () => "viewer server unreachable – is the backend running? (retrying)",
  processing: msg => `processing error: ${msg}`,
};

export interface ConsoleLike { warn(...a: unknown[]): void; info(...a: unknown[]): void; debug(...a: unknown[]): void }

export class Problems {
  private active = new Map<ProblemName, string>();

  constructor(private onChange: (lines: string[]) => void = () => {}, private log: ConsoleLike = console) {}

  fail(name: ProblemName, e: unknown): void {
    const msg = shortError(e);
    if (this.active.get(name) === msg) return;
    this.log.warn(`[${name}] ${msg}`);
    if (name === "processing" && e instanceof Error && e.stack) this.log.debug(e.stack);
    this.active.set(name, msg);
    this.changed();
  }

  ok(name: ProblemName): void {
    if (!this.active.has(name)) return;
    this.log.info(`[${name}] ok again`);
    this.active.delete(name);
    this.changed();
  }

  /** a problem that clears itself after `ms` (failed button actions) */
  flash(name: ProblemName, e: unknown, ms = 5000): void {
    this.fail(name, e);
    const msg = this.active.get(name);
    setTimeout(() => { if (this.active.get(name) === msg) this.ok(name); }, ms);
  }

  has(name: ProblemName): boolean { return this.active.has(name); }

  lines(): string[] {
    return [...this.active].map(([name, msg]) => PANEL_TEXT[name]?.(msg) ?? msg);
  }

  /** health handle for one problem name */
  for(name: ProblemName) { return { fail: (e: unknown) => this.fail(name, e), ok: () => this.ok(name) }; }

  private changed(): void { this.onChange(this.lines()); }
}
