// The source server's HTTP API (all under /api), its WebSocket for processing servers (/ws, ws.ts) and its
// management page (web/dist) at /.
//
//   GET    /api/state                 live sensors (address, rate, clock, errors), recording progress, replays, calibration
//   GET    /api/status?sensor=        a live sensor's REST device values
//   GET    /api/registry/sensors      the configured sensors; POST adds one, PUT/DELETE /api/registry/sensors/{name}
//   GET    /api/rig?recording=        the poses: the live rig, or a recording's; PUT stores them
//   GET    /api/recordings            list (name, bytes, scans, seconds, created, sensors of a session)
//   GET    /api/recordings/{name}     download (a session folder as .zip); DELETE removes it
//   POST   /api/record                {"action": "start" | "stop"}
//   GET    /api/calibration           progress and result; POST {"action": start|cancel|accept|discard, "recording"?, "options"?}
//   GET    /api/calibration/points    the solved result's empty scenes from above (x, y per sensor)
//   GET    /api/consumers             the connected processing servers
//   GET    /api/registry/consumers    the registered ones with their tokens; POST adds one, DELETE /api/registry/consumers/{name}
//   GET    /api/settings              the server's own settings as fields and values (admin); PUT changes some, at once
// Changes need "Authorization: Bearer <adminToken>" once there is one, and are refused from other web pages.
import { statSync } from "node:fs";
import { basename } from "node:path";
import { NotFoundError } from "@mrs6000/server-common/errors";
import { body, errorResponse, guard, json, needToken, notBuilt, oneOf, staticFiles, InvalidRequest } from "@mrs6000/server-common/http";
import { settingsView } from "@mrs6000/server-common/settings";
import type { SettingsSaved } from "@mrs6000/wire/settings";
import type { Hub } from "./hub";
import { listRecordings, recordingPath } from "./recording/catalog";
import { FIELDS, type Store } from "./store";
import type { Consumers } from "./ws";
import { zipFolder } from "./zip";

export type Handler = (req: Request) => Promise<Response>;

export interface AppOptions {
  webDir?: string | null;
  consumers?: Consumers | null;
  onRegistry?: () => void;                   // sensors were added, changed or removed (restart the live sensors)
  onSettings?: (body: Record<string, unknown>) => SettingsSaved;   // settings.ts: check, apply, save
}

export function createApp(hub: Hub, store: Store, o: AppOptions = {}): Handler {
  const files = staticFiles(o.webDir, notBuilt("MRS6000 source", "source-server"));
  const admin = (req: Request) => needToken(req, store.data.adminToken);

  async function api(req: Request, url: URL): Promise<Response> {
    const p = url.pathname, m = req.method, q = (k: string) => url.searchParams.get(k);
    guard(req, store.data.origins);
    if (p === "/api/state" && m === "GET") return json(hub.state());
    if (p === "/api/status" && m === "GET") {
      const s = hub.liveSensor(q("sensor") ?? hub.liveNames()[0] ?? "");
      return json({ device: s.status, error: s.error });
    }

    if (p === "/api/registry/sensors" && m === "GET") return json(store.data.sensors);
    if (p === "/api/registry/sensors" && m === "POST") { admin(req); const e = store.addSensor(await body(req)); o.onRegistry?.(); return json(e); }
    const rm = p.match(/^\/api\/registry\/sensors\/([^/]+)$/);
    if (rm && (m === "PUT" || m === "DELETE")) {
      admin(req);
      const name = decodeURIComponent(rm[1]);
      const out = m === "PUT" ? store.updateSensor(name, await body(req)) : (store.removeSensor(name), store.data.sensors);
      o.onRegistry?.();
      return json(out);
    }

    if (p === "/api/rig" && m === "GET") {
      const rec = q("recording");
      return json(rec === null ? hub.rig("live") : hub.recordingRig(rec));
    }
    if (p === "/api/rig" && m === "PUT") { admin(req); return json(await hub.setRig(await body(req), q("recording"))); }

    if (p === "/api/recordings" && m === "GET") return json(listRecordings(hub.recDir));
    if (p.startsWith("/api/recordings/")) {
      const name = decodeURIComponent(p.slice("/api/recordings/".length)), path = recordingPath(hub.recDir, name);
      if (m === "GET") {
        if (statSync(path).isDirectory())
          return new Response(zipFolder(path), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${basename(path)}.zip"` } });
        return new Response(Bun.file(path), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${basename(path)}"` } });
      }
      if (m === "DELETE") { admin(req); hub.deleteRecording(name); return json(listRecordings(hub.recDir)); }
    }
    if (p === "/api/record" && m === "POST") {
      admin(req);
      if (oneOf((await body(req)).action, ["start", "stop"], "action") === "start") await hub.startRecording();
      else await hub.stopRecording();
      return json(hub.state());
    }

    if (p === "/api/calibration" && m === "GET") return json(hub.calibration?.state() ?? { phase: "idle" });
    if (p === "/api/calibration/points" && m === "GET") {
      const pts = hub.calibration?.points;
      if (!pts) throw new NotFoundError("no calibration result");
      return json(pts);
    }
    if (p === "/api/calibration" && m === "POST") {
      admin(req);
      const b = await body(req), action = oneOf(b.action, ["start", "cancel", "accept", "discard"], "action");
      if (action === "start") {
        if (b.recording !== undefined && typeof b.recording !== "string") throw new InvalidRequest("recording: a recording name");
        const opt = (b.options ?? {}) as Record<string, number>;
        return json(hub.startCalibration((b.recording as string | undefined) ?? null,
                                         { walkSeconds: opt.walkSeconds, minSamples: opt.minSamples, emptySeconds: opt.emptySeconds }).state());
      }
      if (action === "accept") return json(await hub.acceptCalibration());
      hub.stopCalibration();
      return json({ phase: "idle" });
    }

    if (p === "/api/consumers" && m === "GET") return json(o.consumers?.list() ?? []);
    if (p === "/api/registry/consumers" && m === "GET") { admin(req); return json(store.data.consumers); }
    if (p === "/api/registry/consumers" && m === "POST") { admin(req); return json(store.addConsumer(await body(req))); }
    const cm = p.match(/^\/api\/registry\/consumers\/([^/]+)$/);
    if (cm && m === "DELETE") { admin(req); store.removeConsumer(decodeURIComponent(cm[1])); return json(store.data.consumers); }

    if (p === "/api/settings" && m === "GET") { admin(req); return json(settingsView(FIELDS, store.data)); }
    if (p === "/api/settings" && m === "PUT" && o.onSettings) { admin(req); return json(o.onSettings(await body(req))); }
    throw new NotFoundError(p);
  }

  return async req => {
    const url = new URL(req.url);
    try {
      return url.pathname.startsWith("/api/") ? await api(req, url) : files(url);
    } catch (e) {
      return errorResponse(e, `${req.method} ${url.pathname}`);
    }
  };
}
