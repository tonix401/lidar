// Showing several sensors' scans together. Every scan is processed when it arrives (the per-beam histories
// need each one), but drawn only as part of a set: once every sending sensor has a new scan, or `maxWaitMs`
// after the set's first scan, so a stalled sensor never freezes the others. The mirrors are not phase-locked,
// so without this the view updated sensor by sensor, a third of a scan apart. A sensor whose next scan comes
// before the set is complete just stays in it: a set always draws each sensor's latest scan (that is all the
// processor keeps), and closing the set early split it whenever two sensors' phases were close.

export class FrameSync {
  private pending = new Set<number>();
  private first = 0;

  constructor(readonly maxWaitMs = 150) {}

  /** sensor k has a new processed scan at wall time `now` (ms); `sending`: the sensors expected to deliver
   *  (recent frames). Returns the sensors to draw now, or [] to wait for the rest of the set. */
  add(k: number, now: number, sending: number[]): number[] {
    if (!this.pending.size) this.first = now;
    this.pending.add(k);
    return sending.every(s => this.pending.has(s)) ? this.take() : [];
  }

  /** call regularly (animation frame): the pending sensors once the set waited long enough */
  poll(now: number): number[] {
    return this.pending.size && now - this.first >= this.maxWaitMs ? this.take() : [];
  }

  reset(): void { this.pending.clear(); }

  private take(): number[] {
    const out = [...this.pending].sort((a, b) => a - b);
    this.pending.clear();
    return out;
  }
}
