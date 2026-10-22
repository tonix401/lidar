// The source protocol, version 1: what a processing server and the source server say to each other over the source's
// WebSocket (/ws). One connection watches one source: the live sensors, or a replay of a recording, which belongs to
// the connection that asked for it: only that one controls it, and it ends when that connection closes. Others may
// watch a stream replay by its id (`join`); its timeline stays its owner's.
//
//   proc → source   hello      {role: "processing", name, token?}
//                   subscribe  {source: "live"}                          the live sensors
//                   replay     {recording, mode: "stream" | "pull"}      a replay of its own (below)
//                   join       {source}                                  watch another connection's stream replay
//                   control    {action, value?}                          its own stream replay: play, pause, seek, …
//                   credit     {n}                                       pull mode: send n more frames
//   source → proc   welcome    {server, sensors}
//                   subscribed {source, sensors, mode, recording?, count?, owner?, controls?}   (live: again when the
//                                                                               live sensors change; start afresh)
//                   rig        {source, version, rig}                    on subscribing, and whenever it changes
//                   layout     {source, sensor, hdr}                     before a sensor's first frame, and when it changes
//                   (binary)   frame message (frame.ts), meta FrameMeta
//                   state      {source, replay, error}                   a replay's position (stream mode)
//                   status     {sensors: SensorStatus[]}                 the live sensors, about once a second
//                   end        {source}                                  pull mode: every frame has been sent
//                   closed     {source, reason}                          the source is gone (its recording was deleted)
//                   error      {message}
//
// Modes of a replay:
//   stream — paced like the recording (play, pause, seek, speed, loop); `epoch` increments whenever the sequence is
//            not continuous (seek, step back, loop wrap), so per-beam histories can be reset.
//   pull   — every frame in recorded order, as fast as the consumer grants credit, never one dropped: for computing a
//            recording's tracks.
// Live and stream frames are dropped (and counted) while a consumer's send buffer is full; nothing queues up.
import type { Header } from "./frame";
import type { Rig } from "./rig";

export const SOURCE_PROTOCOL = 1;

export type ReplayMode = "stream" | "pull";
export const ACTIONS = ["play", "pause", "toggle", "step", "seek", "speed", "loop"] as const;
export type Action = (typeof ACTIONS)[number];

/** the meta of a binary frame message */
export interface FrameMeta {
  v: number; type: "frame"; source: string; sensor: string;
  k: number;                        // live: the sensor's scan counter; replay: the frame's index in the recording
  t: number;                        // unix s, host clock (live) or as recorded
  rate: number;                     // scans per second, as received or replayed
  epoch: number;
}

/** a replay's position and transport */
export interface PlayerState {
  file?: string; index?: number; count?: number; t?: number; duration?: number; playing?: boolean; speed?: number; loop?: boolean;
  upside_down?: boolean | null;
}

export interface ClockState { offset_s: number; drift_ppm: number; samples: number; resets: number }

/** a live sensor's connection and device */
export interface SensorStatus {
  name: string; ip: string; error: string; rate: number; clock: ClockState; device: string | null; upside_down: boolean | null;
}

export type ToSource =
  | { type: "hello"; role: "processing"; name: string; token?: string }
  | { type: "subscribe"; source: "live" }
  | { type: "replay"; recording: string; mode: ReplayMode }
  | { type: "join"; source: string }
  | { type: "control"; action: Action; value?: number | boolean | null }
  | { type: "credit"; n: number };

export type FromSource =
  | { v: number; type: "welcome"; server: string; sensors: string[] }
  | { v: number; type: "subscribed"; source: string; sensors: string[]; mode: "live" | ReplayMode; recording?: string; count?: number;
      owner?: string; controls?: boolean }   // a replay: who started it, and whether this connection controls it
  | { v: number; type: "rig"; source: string; version: number; rig: Rig }
  | { v: number; type: "layout"; source: string; sensor: string; hdr: Header }
  | { v: number; type: "state"; source: string; replay: PlayerState; error: string }
  | { v: number; type: "status"; sensors: SensorStatus[] }
  | { v: number; type: "end"; source: string }
  | { v: number; type: "closed"; source: string; reason: string }
  | { v: number; type: "error"; message: string };
