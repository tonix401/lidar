// Typed client for the backend API (see backend/src/mrs6000/server/app.py).
import type { FrameMeta, RecordingInfo, ServerState, StatusResponse } from "../core/types";

export type ControlAction = "play" | "pause" | "toggle" | "step" | "seek" | "speed" | "loop";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface Frame { meta: FrameMeta; data: Float32Array }

export class Api {
  constructor(private base = "/api", private fetchFn: typeof fetch = (...a) => fetch(...a)) {}

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

  /** long-poll: the newest frame with id > after (the server answers after ≤ 2 s even without one) */
  async frame(after: number): Promise<Frame | null> {
    const r = await this.fetchFn(`${this.base}/frame?after=${after}`, { cache: "no-store" });
    if (!r.ok) throw new ApiError(`HTTP ${r.status}`, r.status);
    const meta = JSON.parse(r.headers.get("X-Meta") || "{}") as FrameMeta;
    const buf = await r.arrayBuffer();
    if (!meta.id || !buf.byteLength) return null;
    return { meta, data: new Float32Array(buf) };
  }

  state(): Promise<ServerState> { return this.json("/state"); }
  status(): Promise<StatusResponse> { return this.json("/status"); }
  recordings(): Promise<RecordingInfo[]> { return this.json("/recordings"); }
  record(action: "start" | "stop"): Promise<ServerState> { return this.post("/record", { action }); }
  replay(file: string): Promise<ServerState> { return this.post("/replay", { file }); }
  control(action: ControlAction, value?: number | boolean): Promise<ServerState> { return this.post("/replay/control", { action, value }); }
  live(): Promise<ServerState> { return this.post("/live"); }
  deleteRecording(name: string): Promise<RecordingInfo[]> { return this.json(`/recordings/${encodeURIComponent(name)}`, { method: "DELETE" }); }
  downloadUrl(name: string): string { return `${this.base}/recordings/${encodeURIComponent(name)}`; }
}
