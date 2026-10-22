// What the page knows from the object-detection server's messages (libs/wire/src/objects.ts): the current source, its
// sensors and rig, the latest objects, the replay's position, and how many messages arrive per second. No DOM, so the
// tests feed it messages directly.
import type { WorldObject } from "@mrs6000/wire/objects";
import type { Rig } from "@mrs6000/wire/rig";
import type { PlayerState } from "@mrs6000/wire/source";

export type Message = { type: string; [k: string]: unknown };

export class ObjectsModel {
  source = "live";
  sensors: string[] = [];
  rig: Rig = { sensors: [] };
  objects: WorldObject[] = [];
  replay: PlayerState | null = null;
  owner = false;
  t = 0;
  error = "";
  welcome: { server: string; client: { name: string; registered: boolean } } | null = null;
  started = 0;                               // tracks seen starting since subscribing
  private arrivals: number[] = [];

  /** one message; true when what is drawn changed */
  apply(m: Message, now = performance.now()): boolean {
    switch (m.type) {
      case "welcome": this.welcome = m as never; this.error = ""; return false;
      case "subscribed":
        this.source = String(m.source); this.sensors = (m.sensors as string[]) ?? []; this.rig = (m.rig as Rig) ?? { sensors: [] };
        this.replay = (m.replay as PlayerState | null) ?? null; this.owner = !!m.owner; this.objects = []; this.started = 0; this.arrivals = [];
        return true;
      case "objects":
        if (m.source !== this.source) return false;
        this.objects = m.objects as WorldObject[]; this.t = Number(m.t);
        this.arrivals.push(now);
        while (this.arrivals.length && now - this.arrivals[0] > 2000) this.arrivals.shift();
        return true;
      case "track": if (m.event === "start" && m.source === this.source) this.started++; return false;
      case "state": if (m.source === this.source) { this.replay = m.replay as PlayerState; this.error = String(m.error ?? ""); } return false;
      case "closed": if (m.source === this.source) { this.source = "live"; this.replay = null; this.objects = []; this.error = `replay ended (${m.reason})`; } return true;
      case "error": this.error = String(m.message); return false;
      default: return false;
    }
  }

  /** object messages per second over the last two seconds */
  rate(now = performance.now()): number {
    const a = this.arrivals.filter(t => now - t <= 2000);
    return a.length < 2 ? 0 : (a.length - 1) / ((a[a.length - 1] - a[0]) / 1000 || 1);
  }
}
