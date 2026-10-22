// The debug server's HTTP API (all under /api), what the debug page (clients/debug) calls, and the built page at /.
// A view is the live sensors, or with ?session=<id> a replay of the page's own (docs/api.md).
//
//   GET    /api/frame?after=<id>&sensor=<name>&session=<id>   long-poll: a sensor's newest frame (binary, the page's
//                                                             format), meta in X-Meta; without `sensor` the view's first
//   GET    /api/sensors?session=      the view's sensors (name, live, ip, error, rate, clock)
//   GET    /api/rig?session=          their poses, as the source sends them (calibrate on the source server)
//   GET    /api/status?sensor=        a live sensor's REST device values (from the source)
//   GET    /api/state?session=        the view, its epoch, sensors, replay position, the source's recording, errors
//   GET    /api/objects?session=      the server's own fused objects of the view's latest scans
//   POST   /api/sessions              {"recording": name}: a replay of the page's own; its id is what controls it
//                                     {"join": id}: watch another processing server's replay (GET /api/sources)
//   GET    /api/sources               the other processing servers' replays at the source (id, recording, owner)
//   POST   /api/sessions/{id}/control {"action": play|pause|toggle|step|seek|speed|loop, "value": ...}
//   DELETE /api/sessions/{id}
//   GET    /api/recordings            the source's recordings
//   GET    /api/config                the server's processing settings; PUT replaces them
//   GET    /api/settings              the server's own settings as fields and values (admin); PUT changes some, at once
// Changes are refused from other web pages; PUT /api/config and the settings need "Authorization: Bearer <adminToken>"
// once there is one.
import { mergeConfig } from "@mrs6000/processing/config/config";
import { NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { body, errorResponse, guard, InvalidRequest, json, needToken, notBuilt, oneOf, staticFiles } from "@mrs6000/server-common/http";
import { settingsView } from "@mrs6000/server-common/settings";
import { sourceGet } from "@mrs6000/server-common/sourceClient";
import type { SettingsSaved } from "@mrs6000/wire/settings";
import { ACTIONS } from "@mrs6000/wire/source";
import type { Hub } from "./hub";
import { FIELDS, type Store } from "./store";

export type Handler = (req: Request) => Promise<Response>;

/** `onSettings`: settings.ts (check, apply, save) */
export function createApp(hub: Hub, store: Store, webDir: string | null = null,
                          onSettings?: (body: Record<string, unknown>) => Promise<SettingsSaved>): Handler {
  const files = staticFiles(webDir, notBuilt("MRS6000 viewer", "clients/debug"));

  async function api(req: Request, url: URL): Promise<Response> {
    const p = url.pathname, m = req.method, q = (k: string) => url.searchParams.get(k), session = q("session");
    guard(req, store.data.origins);
    const view = hub.view(session);                                          // 404 for an ended replay; kept while asked about
    const known = (sensor: string | null) => {
      if (sensor !== null && !view.sensors.includes(sensor)) throw new NotFoundError(`sensor ${sensor}`);
      return sensor;
    };
    if (p === "/api/frame" && m === "GET") {
      const name = known(q("sensor")) ?? view.sensors[0];
      if (name === undefined) { await Bun.sleep(1000); return new Response(new Uint8Array(0), { headers: { "X-Meta": "{}", "Cache-Control": "no-store" } }); }
      const f = await view.feed(name).wait(Number(q("after") ?? 0) || 0);
      return new Response(f.data, { headers: { "Content-Type": "application/octet-stream", "X-Meta": JSON.stringify({ ...f.meta, id: f.id }), "Cache-Control": "no-store" } });
    }
    if (p === "/api/sensors" && m === "GET") return json(hub.sensorInfo(session));
    if (p === "/api/rig" && m === "GET") return json(view.pipeline.rig);
    if (p === "/api/status" && m === "GET") {
      const sensor = known(q("sensor"));
      if (!view.live) return json({ device: {}, error: "" });                 // a replayed sensor has no device to ask
      if (sensor === null) return json({ device: {}, error: hub.live.liveError() });
      try { return json(await sourceGet(hub.source, `/api/status?sensor=${encodeURIComponent(sensor)}`)); } catch (e) {
        return json({ device: {}, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (p === "/api/state" && m === "GET") return json(hub.state(session));
    if (p === "/api/objects" && m === "GET") return json(view.objects ?? { t: 0, seq: 0, k: 0, sensors: [], objects: [] });

    if (p === "/api/sources" && m === "GET") return json(await hub.otherReplays());
    if (p === "/api/sessions" && m === "POST") {
      const b = await body(req);
      if (typeof b.join === "string") {
        const v = await hub.joinSession(b.join);
        return json({ id: v.id, recording: v.recording, sensors: v.sensors, owner: v.owner, controls: false });
      }
      if (typeof b.recording !== "string") throw new InvalidRequest("recording: a recording name (or join: a replay's id)");
      const v = await hub.createSession(b.recording);
      return json({ id: v.id, recording: v.recording, sensors: v.sensors, owner: v.owner, controls: true });
    }
    const sm = p.match(/^\/api\/sessions\/([^/]+)(\/control)?$/);
    if (sm) {
      const v = hub.view(decodeURIComponent(sm[1]));
      if (sm[2] && m === "POST") {
        const b = await body(req), value = b.value ?? null;
        if (value !== null && typeof value !== "boolean" && typeof value !== "number") throw new InvalidRequest("value: a number, true/false or null");
        if (!v.controls) throw new ValueError(`${v.owner || "another server"} controls this replay; this page only watches it`);
        v.pipeline.conn.control(oneOf(b.action, ACTIONS, "action"), value);
        return json(hub.state(v.id));
      }
      if (!sm[2] && m === "DELETE") { if (!v.keep) hub.closeSession(v.id); return json({ ok: true }); }
    }
    if (p === "/api/recordings" && m === "GET") return json(await sourceGet(hub.source, "/api/recordings"));
    if (p === "/api/config" && m === "GET") return json(hub.cfg);
    if (p === "/api/config" && m === "PUT") {
      needToken(req, store.data.adminToken);
      const cfg = mergeConfig(hub.cfg, await body(req));
      hub.setConfig(cfg);
      store.processing = cfg;
      return json(cfg);
    }
    if (p === "/api/settings" && m === "GET") { needToken(req, store.data.adminToken); return json(settingsView(FIELDS, store.data)); }
    if (p === "/api/settings" && m === "PUT" && onSettings) { needToken(req, store.data.adminToken); return json(await onSettings(await body(req))); }
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
