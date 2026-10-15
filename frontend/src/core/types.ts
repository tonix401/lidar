// Shapes of the backend API (see backend/src/mrs6000/server/app.py)

export type Source = "live" | "replay";

export interface ReplayState {
  file: string;
  index: number;
  count: number;
  t: number;
  duration: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  upside_down: boolean | null;
}

/** Meta of one /api/frame response (X-Meta header). */
export interface FrameMeta {
  id: number;
  points: number;
  layers: number;
  beams: number;
  start_azimuth_deg: number;
  step_deg: number;
  rate: number;
  scan_frequency_hz: number;
  ts: number;
  source?: Source;
  epoch?: number;
  replay?: ReplayState;
}

export interface RecordingState {
  active: boolean;
  error?: string;
  file?: string;
  scans?: number;
  bytes?: number;
  seconds?: number;
}

export interface ServerState {
  source: Source;
  epoch: number;
  replay: Partial<ReplayState>;
  recording: RecordingState;
  live_error: string;
  replay_error: string;
  sensor: boolean;
}

export interface RecordingInfo {
  name: string;
  bytes: number;
  scans?: number;
  seconds?: number;
  created?: number;
  error?: string;
}

export interface StatusResponse {
  device: Record<string, unknown>;
  error: string;
}

export type Mount = "upright" | "upsidedown";
export type RGB = [number, number, number];

/** the current theme's colours as CSS colour strings (read by ui/theme.ts, used by the canvas and WebGL views) */
export interface ThemeColors { bg: string; border: string; text: string; muted: string; accent: string; warn: string;
                               grid: string; grid2: string; axis: string; mark: string; field: string }
