// A recording's tracks computed in the background into the track cache (trackCache.ts): the source sends every frame
// in recorded order (pull mode), as fast as the sensor workers go; afterwards, replays of it cost almost nothing.
import type { Config } from "@mrs6000/processing/config/config";
import { log } from "@mrs6000/server-common/log";
import { SourcePipeline } from "@mrs6000/server-common/pipeline";
import type { SourceAddress } from "@mrs6000/server-common/sourceClient";
import { cacheDir, cacheKey, CacheWriter } from "./trackCache";

export interface BatchState { recording: string; done: number; total: number; running: boolean; error: string; seconds: number }

export class BatchJob {
  done = 0;
  total = 0;
  running = true;
  error = "";
  private t0 = performance.now();
  private writer: CacheWriter | null = null;
  private pipeline: SourcePipeline;
  private stop: (error?: string) => void;
  readonly finished: Promise<void>;

  /** `threaded` false: every sensor on the main thread (the tracks are then the same to the byte on every run) */
  constructor(readonly recording: string, source: SourceAddress, cfg: Config, cacheRoot: string, threaded = true) {
    let finish: () => void = () => {};
    this.finished = new Promise(r => { finish = r; });
    const stop = this.stop = (error = "") => {
      if (!this.running) return;
      this.error = error;
      if (error || this.done < this.total) this.writer?.abort(); else this.writer?.complete();
      this.running = false;
      this.pipeline.close();
      if (!error) log(`tracks of ${recording} computed (${this.state().seconds} s)`);
      finish();
    };
    this.pipeline = new SourcePipeline(source, { kind: "replay", recording, mode: "pull" }, cfg, {
      subscribed: s => { this.total = s.count ?? 0; },
      rig: rig => {
        if (this.writer) return stop("the recording's rig changed during the run");
        this.writer = new CacheWriter(cacheDir(cacheRoot, recording), cacheKey(cfg, rig, this.total));
      },
      frame: f => { this.done = f.seq + 1; },
      objects: t => this.writer?.add(t),
      end: () => stop(),
      closed: reason => stop(reason),
      error: e => stop(e),
    }, { threaded });
  }

  cancel(): void { this.stop("cancelled"); }

  state(): BatchState {
    return { recording: this.recording, done: this.done, total: this.total, running: this.running, error: this.error,
             seconds: Math.round((performance.now() - this.t0) / 100) / 10 };
  }
}
