// Short console logging of a subsystem's problems: one line when a problem starts or changes, a reminder once a
// minute, one line when it is gone, never a stack trace per retry. And the loop supervision built on it.
import { describeError } from "./errors";
import { log } from "./log";

/** error state of one subsystem */
export class Health {
  static REMIND_S = 60;
  remindS = Health.REMIND_S;
  error = "";
  private since = 0;
  private reminded = 0;

  constructor(readonly name: string, readonly retryS: number | null = null, private logger: (line: string) => void = log) {}

  /** record a failure; returns the short message */
  fail(e: unknown): string {
    const msg = typeof e === "string" ? e : describeError(e), now = Date.now() / 1000;
    if (msg !== this.error) {
      this.logger(`${this.name}: ${msg}` + (this.retryS ? ` (retrying every ${this.retryS} s)` : ""));
      this.since = this.reminded = now;
    } else if (now - this.reminded >= this.remindS) {
      this.logger(`${this.name}: still failing after ${Math.floor(now - this.since)} s: ${msg}`);
      this.reminded = now;
    }
    this.error = msg;
    return msg;
  }

  ok(): void {
    if (this.error) { this.logger(`${this.name}: ok again`); this.error = ""; }
  }
}

/** a stop flag that can be awaited: `wait(s)` sleeps until the time is up or stop() is called */
export class Stop {
  private stopped = false;
  private wakers = new Set<() => void>();
  get isSet(): boolean { return this.stopped; }
  set(): void { this.stopped = true; for (const w of this.wakers) w(); this.wakers.clear(); }
  wait(seconds: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); this.wakers.delete(done); resolve(); };
      const t = setTimeout(done, seconds * 1000);
      this.wakers.add(done);
    });
  }
}

/** Wakes everyone waiting for a change (the Hub's replacement for a condition variable). */
export class Signal {
  private waiters: (() => void)[] = [];
  notify(): void { const w = this.waiters; this.waiters = []; for (const f of w) f(); }
  /** resolves at the next notify(), or after `seconds` (resolves false then) */
  wait(seconds = Infinity): Promise<boolean> {
    return new Promise(resolve => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const f = () => { clearTimeout(t); resolve(true); };
      this.waiters.push(f);
      if (Number.isFinite(seconds)) t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== f); resolve(false); }, Math.max(0, seconds * 1000));
    });
  }
}

/** run a loop until `stop`; if it ever throws or returns early, log one line and restart it */
export async function supervised(name: string, fn: () => Promise<void>, stop: Stop, restartS = 3, logger: (line: string) => void = log): Promise<void> {
  const health = new Health(name, null, logger);
  while (!stop.isSet) {
    try {
      await fn();
      if (!stop.isSet) health.fail("loop ended unexpectedly, restarting");
    } catch (e) {
      health.fail(`crashed (${describeError(e)}), restarting`);
    }
    await stop.wait(restartS);
  }
}
