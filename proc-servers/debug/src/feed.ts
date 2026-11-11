// A sensor's latest published frame; readers wait until a newer one arrives (long-poll).
// A frame can be published as a recipe (publishLazy): it is only built when a reader asks for it, so the frames
// that arrive while no page is polling (or faster than it polls) cost nothing.
import { Signal } from "@mrs6000/server-common/health";

export type Meta = Record<string, unknown>;
type Built = { data: Uint8Array; meta: Meta };

export class Feed {
  frameId = 0;
  private built: Built | null = { data: new Uint8Array(0), meta: {} };
  private make: (() => Built) | null = null;
  private changed = new Signal();

  publish(data: Uint8Array, meta: Meta): void { this.set({ data, meta }, null); }

  /** the newest frame as a recipe, run on the first read */
  publishLazy(make: () => Built): void { this.set(null, make); }

  get data(): Uint8Array { return this.current().data; }
  get meta(): Meta { return this.current().meta; }

  /** the newest frame once its id is > `after`, or the current one after `timeoutS` */
  async wait(after: number, timeoutS = 2): Promise<{ id: number; data: Uint8Array; meta: Meta }> {
    const end = performance.now() + timeoutS * 1000;
    while (this.frameId <= after) {
      const left = (end - performance.now()) / 1000;
      if (left <= 0 || !(await this.changed.wait(left))) break;
    }
    const { data, meta } = this.current();
    return { id: this.frameId, data, meta: { ...meta } };
  }

  private set(built: Built | null, make: (() => Built) | null): void {
    this.frameId++;
    this.built = built; this.make = make;
    this.changed.notify();
  }

  private current(): Built {
    if (!this.built) { this.built = this.make!(); this.make = null; }
    return this.built;
  }
}
