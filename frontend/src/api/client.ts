// Typed client for the server's HTTP API (server/src/http.ts). The page watches one source: the live sensors, or a
// replay session of its own (or the one the server was started with, --replay); `session` names it.
import type { FrameMeta, RecordingInfo, Rig, RigSensor, SensorInfo, ServerState, StatusResponse } from "@mrs6000/processing/core/types";

export type ControlAction = "play" | "pause" | "toggle" | "step" | "seek" | "speed" | "loop";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface Frame { meta: FrameMeta; data: Float32Array }

export class Api {
  /** the replay session this page watches (null: the live sensors; undefined: not asked yet) */
  session: string | null | undefined = undefined;
  private ownSession = false;               // created by this page: ended when it leaves it

  constructor(private base = "/api", private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  private get q(): string { return this.session ? `session=${encodeURIComponent(this.session)}` : ""; }
  private withQ(path: string): string { return this.q ? `${path}${path.includes("?") ? "&" : "?"}${this.q}` : path; }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.fetchFn(this.base + path, { cache: "no-store", ...init });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = (body as { error?: string; detail?: unknown }).error ??
        (Array.isArray((body as { detail?: unknown }).detail) ? "invalid request" : undefined);
      throw new ApiError(detail || `HTTP ${r.status}`, r.status);
    }
    return body as T;
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" },
                                body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** long-poll: a sensor's newest frame with id > after (the server answers after ≤ 2 s even without one);
   *  without `sensor`, the current source's first */
  async frame(after: number, sensor?: string): Promise<Frame | null> {
    const q = (sensor === undefined ? "" : `&sensor=${encodeURIComponent(sensor)}`) + (this.q ? `&${this.q}` : "");
    const r = await this.fetchFn(`${this.base}/frame?after=${after}${q}`, { cache: "no-store" });
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status);
    const meta = JSON.parse(r.headers.get("X-Meta") || "{}") as FrameMeta;
    const buf = await r.arrayBuffer();
    if (!meta.id || !buf.byteLength) return null;
    return { meta, data: new Float32Array(buf) };
  }

  /** the state of the page's source; the first time, the server's default session (--replay) if it has one. A
   *  session that ended (nobody watched it for a while, its recording was deleted) means back to live. */
  async state(): Promise<ServerState> {
    if (this.session === undefined) {
      const live = await this.json<ServerState>("/state");
      this.session = live.default_session ?? null;
      if (!this.session) return live;
    }
    try {
      return await this.json<ServerState>(this.withQ("/state"));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404 && this.session)) throw e;
      this.session = null; this.ownSession = false;
      return this.json<ServerState>("/state");
    }
  }
  status(sensor?: string): Promise<StatusResponse> { return this.json(this.withQ(sensor === undefined ? "/status" : `/status?sensor=${encodeURIComponent(sensor)}`)); }
  sensors(): Promise<SensorInfo[]> { return this.json(this.withQ("/sensors")); }
  rig(): Promise<Rig> { return this.json(this.withQ("/rig")); }
  /** store calibration results (the live rig, or the session folder while replaying one) */
  putRig(sensors: Partial<RigSensor>[]): Promise<Rig> {
    return this.json(this.withQ("/rig"), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sensors }) });
  }
  recordings(): Promise<RecordingInfo[]> { return this.json("/recordings"); }
  record(action: "start" | "stop"): Promise<ServerState> { return this.post("/record", { action }); }
  /** replay a recording in a session of this page's own (others' replays and the live sensors go on) */
  async replay(file: string): Promise<ServerState> {
    const s = await this.post<{ id: string }>("/sessions", { recording: file });
    this.leave();
    this.session = s.id; this.ownSession = true;
    return this.state();
  }
  control(action: ControlAction, value?: number | boolean): Promise<ServerState> {
    if (!this.session) return Promise.reject(new ApiError("not replaying", 400));
    return this.post(`/sessions/${encodeURIComponent(this.session)}/control`, { action, value });
  }
  /** back to the live sensors */
  live(): Promise<ServerState> { this.leave(); this.session = null; return this.state(); }
  deleteRecording(name: string): Promise<RecordingInfo[]> { return this.json(`/recordings/${encodeURIComponent(name)}`, { method: "DELETE" }); }
  downloadUrl(name: string): string { return `${this.base}/recordings/${encodeURIComponent(name)}`; }

  /** end the session this page created (not the server's default one, which others may watch) */
  private leave(): void {
    if (this.session && this.ownSession) void this.fetchFn(`${this.base}/sessions/${encodeURIComponent(this.session)}`, { method: "DELETE" }).catch(() => {});
    this.ownSession = false;
  }
}
