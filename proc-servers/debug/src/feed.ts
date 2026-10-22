// A sensor's latest published frame; readers wait until a newer one arrives (long-poll).
import { Signal } from "@mrs6000/server-common/health";

export type Meta = Record<string, unknown>;

export class Feed {
  frameId = 0;
  data: Uint8Array = new Uint8Array(0);
  meta: Meta = {};
  private changed = new Signal();

  publish(data: Uint8Array, meta: Meta): void {
    this.frameId++;
    this.data = data; this.meta = meta;
    this.changed.notify();
  }

  /** the newest frame once its id is > `after`, or the current one after `timeoutS` */
  async wait(after: number, timeoutS = 2): Promise<{ id: number; data: Uint8Array; meta: Meta }> {
    const end = performance.now() + timeoutS * 1000;
    while (this.frameId <= after) {
      const left = (end - performance.now()) / 1000;
      if (left <= 0 || !(await this.changed.wait(left))) break;
    }
    return { id: this.frameId, data: this.data, meta: { ...this.meta } };
  }
}
