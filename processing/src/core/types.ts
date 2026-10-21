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
  sensor?: string;                 // which sensor of the rig
  upside_down?: boolean | null;    // its mount, when known
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
  sensors?: string[];              // the current source's sensors
  session?: string | null;         // the replay session this state is of (null: the live sensors)
  default_session?: string | null; // the session started with --replay: what a page shows first
}

/** /api/sensors: one sensor of the current source */
export interface SensorInfo {
  name: string; live: boolean; ip?: string; error?: string; rate?: number; device?: string; upside_down?: boolean | null;
  clock?: { offset_s: number; drift_ppm: number; samples: number; resets: number };
}

/** the rig (backend/src/mrs6000/rig.py): poses in m and degrees */
export interface RigPose { x: number; y: number; z: number; yaw: number; pitch: number; roll: number }
export interface RigSensor {
  name: string; ip?: string; pose?: RigPose; time_offset_s?: number; calibrated?: string;
  quality?: Record<string, unknown>;
}
export interface Rig { sensors: RigSensor[] }

export interface RecordingInfo {
  name: string;
  bytes: number;
  scans?: number;
  seconds?: number;
  created?: number;
  error?: string;
  sensors?: string[];              // a multi-sensor session
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
