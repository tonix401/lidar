// The object-detection server's HTTP API (all under /api), its clients' WebSocket (/ws, ws.ts) and the reference
// client page (clients/object-detection) at /.
//
//   GET    /api/state                 its name, the source connection, the live sensors and their rig, replays, jobs
//   GET    /api/config                the processing settings; PUT replaces them
//   GET    /api/recordings            the source's recordings
//   POST   /api/recordings/{name}/process   compute its tracks in the background (the track cache); GET: progress
//   DELETE /api/recordings/{name}/cache     forget its cached tracks
//   GET    /api/clients               the registered clients (with their tokens); POST adds one, PUT/DELETE /api/clients/{id}
//   GET    /api/connections           the connected clients
//   GET    /api/replays               the replays and who watches them
//   GET    /api/settings              the server's own settings as fields and values (admin); PUT changes some, at once
// Changes, and what reveals tokens or replays, need "Authorization: Bearer <adminToken>" once there is one; changes
// are refused from other web pages.
import { mergeConfig } from "@mrs6000/processing/config/config";
import { NotFoundError } from "@mrs6000/server-common/errors";
import { body, errorResponse, guard, json, needToken, notBuilt, staticFiles } from "@mrs6000/server-common/http";
import { settingsView } from "@mrs6000/server-common/settings";
import { sourceGet } from "@mrs6000/server-common/sourceClient";
import type { SettingsSaved } from "@mrs6000/wire/settings";
import type { Hub } from "./hub";
import { FIELDS, type Store } from "./store";
import type { Clients } from "./ws";

export type Handler = (req: Request) => Promise<Response>;

/** `onSettings`: settings.ts (check, apply, save) */
export function createApp(hub: Hub, store: Store, clients: Clients | null, webDir: string | null = null,
                          onSettings?: (body: Record<string, unknown>) => SettingsSaved): Handler {
  const files = staticFiles(webDir, notBuilt("MRS6000 objects", "clients/object-detection"));
  const admin = (req: Request) => needToken(req, store.data.adminToken);

  async function api(req: Request, url: URL): Promise<Response> {
    const p = url.pathname, m = req.method;
    guard(req, store.data.origins);
    if (p === "/api/state" && m === "GET") return json(hub.state());
    if (p === "/api/config" && m === "GET") return json(hub.cfg);
    if (p === "/api/config" && m === "PUT") {
      admin(req);
      const cfg = mergeConfig(hub.cfg, await body(req));
      hub.setConfig(cfg);
      store.processing = cfg;
      return json(cfg);
    }
    if (p === "/api/recordings" && m === "GET") return json(await sourceGet(hub.source, "/api/recordings"));
    const pm = p.match(/^\/api\/recordings\/([^/]+)\/(process|cache)$/);
    if (pm) {
      const name = decodeURIComponent(pm[1]);
      if (pm[2] === "process" && m === "POST") { admin(req); return json(hub.processRecording(name).state()); }
      if (pm[2] === "process" && m === "GET") { const j = hub.jobs.get(name); if (!j) throw new NotFoundError(`no job for ${name}`); return json(j.state()); }
      if (pm[2] === "cache" && m === "DELETE") { admin(req); hub.dropCache(name); return json({ ok: true }); }
    }
    if (p === "/api/clients" && m === "GET") { admin(req); return json(store.data.clients); }
    if (p === "/api/clients" && m === "POST") { admin(req); return json(store.addClient(await body(req))); }
    const cm = p.match(/^\/api\/clients\/([^/]+)$/);
    if (cm && m === "PUT") { admin(req); return json(store.updateClient(decodeURIComponent(cm[1]), await body(req))); }
    if (cm && m === "DELETE") { admin(req); store.removeClient(decodeURIComponent(cm[1])); return json(store.data.clients); }
    if (p === "/api/connections" && m === "GET") { admin(req); return json(clients?.list() ?? []); }
    if (p === "/api/replays" && m === "GET") { admin(req); return json([...hub.replays.values()].map(r => r.info())); }
    if (p === "/api/settings" && m === "GET") { admin(req); return json(settingsView(FIELDS, store.data)); }
    if (p === "/api/settings" && m === "PUT" && onSettings) { admin(req); return json(onSettings(await body(req))); }
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
