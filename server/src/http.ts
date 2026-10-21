// HTTP API (all under /api), the WebSocket (/ws, ws.ts) and the built frontend (frontend/dist) at /.
// A source is the live sensors, or with ?session=<id> a replay session (docs/api.md).
//
//   GET    /api/frame?after=<id>&sensor=<name>&session=<id>   long-poll: a sensor's newest frame (binary, frames.ts),
//                                                             meta in X-Meta; without `sensor` the source's first
//   GET    /api/sensors?session=      the source's sensors (name, live, ip, error, rate, clock)
//   GET    /api/rig?session=          their poses (rig.ts); PUT stores calibration results (the live rig, or the session folder)
//   GET    /api/status?sensor=&session=   REST device values + sensor error (a replayed sensor: none)
//   GET    /api/state?session=        the source, its epoch, sensors, replay position, recording progress, errors
//   GET    /api/sessions              the replay sessions; POST {"recording": name} starts one
//   POST   /api/sessions/{id}/control {"action": play|pause|toggle|step|seek|speed|loop, "value": ...}
//   DELETE /api/sessions/{id}
//   GET    /api/recordings            list (name, bytes, scans, seconds, created, sensors of a session)
//   GET    /api/recordings/{name}     download (a session folder as .zip); DELETE removes it
//   POST   /api/recordings/{name}/process   compute its tracks in the background (the track cache); GET: progress
//   POST   /api/record                {"action": "start" | "stop"}
//   GET    /api/calibration           the calibration's progress and result; POST {"action": start|cancel|accept|discard, "session"?}
//   GET    /api/config                the processing settings; PUT replaces them
//   GET    /api/registry/sensors      the configured sensors; POST adds one, PUT/DELETE /api/registry/sensors/{name}
//   GET    /api/clients               the registered clients (with their tokens); POST adds one, PUT/DELETE /api/clients/{id}
// Changes need "Authorization: Bearer <adminToken>" once the store has one.
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { mergeConfig } from "@mrs6000/processing/config/config";
import { describeError, NotFoundError, ValueError } from "./errors";
import type { Hub } from "./hub";
import { log } from "./log";
import { ACTIONS } from "./player";
import { listRecordings, recordingPath } from "./recording/catalog";
import type { Store } from "./store";
import { zipFolder } from "./zip";

/** a request body that does not have the expected shape: HTTP 422 */
class InvalidRequest extends Error { override name = "InvalidRequest"; }
/** a change without the admin token: HTTP 401 */
class Unauthorized extends Error { override name = "Unauthorized"; }

const NO_FRONTEND = `<!doctype html><meta charset="utf-8"><title>MRS6000 viewer</title>
<body style="font:14px system-ui;background:#0e1116;color:#d7dde5;padding:2em">
<h1>Frontend not built</h1><p>Run <code>make build</code> (or <code>cd frontend && bun run build</code>),
or use the dev server: <code>make dev</code> → http://localhost:5173.</p>`;

const json = (obj: unknown, status = 200) => Response.json(obj, { status });

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* below */ }
  throw new InvalidRequest("expected a JSON object");
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new InvalidRequest(`${what}: one of ${allowed.join(", ")}`);
  return v as T;
}

export type Handler = (req: Request) => Promise<Response>;

export interface AppOptions {
  frontendDir?: string | null;
  store?: Store | null;                      // registry, clients, processing settings (none: only the live rig)
  onRegistry?: () => void;                   // sensors were added, changed or removed (restart the live sensors)
}

export function createApp(hub: Hub, recDir: string, o: AppOptions = {}): Handler {
  const front = o.frontendDir && existsSync(join(o.frontendDir, "index.html")) ? resolve(o.frontendDir) : null;
  const store = o.store ?? null;

  const known = (sensor: string | null, session: string | null) => {
    if (sensor !== null && !hub.sensors(session).includes(sensor)) throw new NotFoundError(`sensor ${sensor}`);
    return sensor;
  };
  const admin = (req: Request) => {
    const token = store?.data.adminToken;
    if (token && req.headers.get("authorization") !== `Bearer ${token}`) throw new Unauthorized("this needs the admin token");
  };
  const needStore = () => { if (!store) throw new NotFoundError("no registry (the server runs without a store)"); return store; };

  async function api(req: Request, url: URL): Promise<Response> {
    const p = url.pathname, m = req.method, q = (k: string) => url.searchParams.get(k), session = q("session");
    if (session !== null) hub.session(session).touch();                       // 404 for an ended session; kept while used
    if (p === "/api/frame" && m === "GET") {
      const f = await hub.feed(known(q("sensor"), session), session).wait(Number(q("after") ?? 0) || 0);
      return new Response(f.data, { headers: { "Content-Type": "application/octet-stream", "X-Meta": JSON.stringify({ ...f.meta, id: f.id }), "Cache-Control": "no-store" } });
    }
    if (p === "/api/sensors" && m === "GET") return json(hub.sensorInfo(session));
    if (p === "/api/rig" && m === "GET") return json(hub.currentRig(session));
    if (p === "/api/rig" && m === "PUT") { admin(req); return json(hub.setRig(await body(req), session)); }
    if (p === "/api/status" && m === "GET") {               // a replayed sensor has no device to ask
      const sensor = known(q("sensor"), session), s = session === null ? hub.liveSensor(sensor) : null;
      if (sensor === null) return json({ device: s?.status ?? {}, error: hub.liveError() });   // every live sensor's error
      return json({ device: s?.status ?? {}, error: s?.error ?? "" });
    }
    if (p === "/api/state" && m === "GET") return json(hub.state(session));

    if (p === "/api/sessions" && m === "GET") return json(hub.sessionInfo());
    if (p === "/api/sessions" && m === "POST") {
      const rec = (await body(req)).recording;
      if (typeof rec !== "string") throw new InvalidRequest("recording: a recording name");
      return json(hub.createSession(recordingPath(recDir, rec)).info());
    }
    const sm = p.match(/^\/api\/sessions\/([^/]+)(\/control)?$/);
    if (sm) {
      const s = hub.session(decodeURIComponent(sm[1]));
      if (sm[2] && m === "POST") {
        const b = await body(req), value = b.value ?? null;
        if (value !== null && typeof value !== "boolean" && typeof value !== "number") throw new InvalidRequest("value: a number, true/false or null");
        s.control(oneOf(b.action, ACTIONS, "action"), value);
        return json(hub.state(s.id));
      }
      if (!sm[2] && m === "GET") return json(s.info());
      if (!sm[2] && m === "DELETE") { hub.closeSession(s.id); return json(hub.sessionInfo()); }
    }

    if (p === "/api/recordings" && m === "GET") return json(listRecordings(recDir));
    const pm = p.match(/^\/api\/recordings\/([^/]+)\/process$/);
    if (pm) {
      const path = recordingPath(recDir, decodeURIComponent(pm[1]));
      if (m === "POST") { admin(req); return json(hub.processRecording(path).state()); }
      if (m === "GET") { const j = hub.jobs.get(path); if (!j) throw new NotFoundError(`no job for ${basename(path)}`); return json(j.state()); }
    }
    if (p.startsWith("/api/recordings/")) {
      const path = recordingPath(recDir, decodeURIComponent(p.slice("/api/recordings/".length)));
      if (m === "GET") {
        if (statSync(path).isDirectory())
          return new Response(zipFolder(path), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${basename(path)}.zip"` } });
        return new Response(Bun.file(path), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${basename(path)}"` } });
      }
      if (m === "DELETE") { admin(req); hub.deleteRecording(path); return json(listRecordings(recDir)); }
    }
    if (p === "/api/record" && m === "POST") {
      admin(req);
      if (oneOf((await body(req)).action, ["start", "stop"], "action") === "start") await hub.startRecording();
      else await hub.stopRecording();
      return json(hub.state());
    }

    if (p === "/api/calibration" && m === "GET") return json(hub.calibration?.state() ?? { phase: "idle" });
    if (p === "/api/calibration" && m === "POST") {
      admin(req);
      const b = await body(req), action = oneOf(b.action, ["start", "cancel", "accept", "discard"], "action");
      if (action === "start") {
        const target = typeof b.session === "string" ? b.session : null, o = (b.options ?? {}) as Record<string, number>;
        return json(hub.startCalibration(target, { walkSeconds: o.walkSeconds, minSamples: o.minSamples, emptySeconds: o.emptySeconds }).state());
      }
      if (action === "accept") return json(hub.acceptCalibration());
      hub.stopCalibration();
      return json({ phase: "idle" });
    }
    if (p === "/api/config" && m === "GET") return json(hub.cfg);
    if (p === "/api/config" && m === "PUT") {
      admin(req);
      const cfg = mergeConfig(hub.cfg, await body(req));
      hub.setConfig(cfg);
      if (store) store.processing = cfg;
      return json(cfg);
    }

    if (p === "/api/registry/sensors" && m === "GET") return json(needStore().data.sensors);
    if (p === "/api/registry/sensors" && m === "POST") { admin(req); const e = needStore().addSensor(await body(req)); o.onRegistry?.(); return json(e); }
    const rm = p.match(/^\/api\/registry\/sensors\/([^/]+)$/);
    if (rm && (m === "PUT" || m === "DELETE")) {
      admin(req);
      const name = decodeURIComponent(rm[1]);
      const out = m === "PUT" ? needStore().updateSensor(name, await body(req)) : (needStore().removeSensor(name), needStore().data.sensors);
      o.onRegistry?.();
      return json(out);
    }

    if (p === "/api/clients" && m === "GET") { admin(req); return json(needStore().data.clients); }
    if (p === "/api/clients" && m === "POST") { admin(req); return json(needStore().addClient(await body(req))); }
    const cm = p.match(/^\/api\/clients\/([^/]+)$/);
    if (cm && m === "PUT") { admin(req); return json(needStore().updateClient(decodeURIComponent(cm[1]), await body(req))); }
    if (cm && m === "DELETE") { admin(req); needStore().removeClient(decodeURIComponent(cm[1])); return json(needStore().data.clients); }
    throw new NotFoundError(p);
  }

  function files(url: URL): Response {
    if (!front) return url.pathname === "/" ? new Response(NO_FRONTEND, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : json({ error: "not found" }, 404);
    let path = resolve(front, "." + decodeURIComponent(url.pathname));
    if (path !== front && !path.startsWith(front + sep)) return json({ error: "not found" }, 404);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) return json({ error: "not found" }, 404);
    return new Response(Bun.file(path));
  }

  return async req => {
    const url = new URL(req.url);
    try {
      return url.pathname.startsWith("/api/") ? await api(req, url) : files(url);
    } catch (e) {
      if (e instanceof InvalidRequest) return json({ error: e.message }, 422);
      if (e instanceof Unauthorized) return json({ error: e.message }, 401);
      if (e instanceof ValueError) return json({ error: e.message || "ValueError" }, 400);
      if (e instanceof NotFoundError) return json({ error: `not found: ${e.message}` }, 404);
      const msg = describeError(e);
      log(`http ${req.method} ${url.pathname}: ${msg}`);
      return json({ error: msg }, 500);
    }
  };
}
