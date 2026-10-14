// Frame long-poll loop: never throws, retries with backoff (1 s → 5 s), reports connectivity once.
import type { Api, Frame } from "./client";

export interface StreamHealth { fail(e: unknown): void; ok(): void }

export class FrameStream {
  private lastId = 0;
  private running = false;
  retryMs = 1000;

  constructor(private api: Api, private onFrame: (f: Frame) => void, private health: StreamHealth,
              private sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))) {}

  async run(maxIterations = Infinity): Promise<void> {
    this.running = true;
    for (let k = 0; this.running && k < maxIterations; k++) {
      try {
        const f = await this.api.frame(this.lastId);
        if (f && f.meta.id !== this.lastId) {
          this.lastId = f.meta.id;
          this.onFrame(f);
        }
        this.health.ok();
        this.retryMs = 1000;
      } catch (e) {
        this.health.fail(e);
        await this.sleep(this.retryMs);
        this.retryMs = Math.min(5000, this.retryMs * 1.5);
      }
    }
  }

  stop(): void { this.running = false; }
}
