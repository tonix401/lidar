// Mesh / lines: a display setting (render/geometry.ts), listed with the stages so the panel shows it with them.
import type { StageDef } from "./types";

export type MeshConfig = { jump: number; jumpRel: number };

export const meshStage: StageDef<"mesh"> = {
  key: "mesh", title: "Mesh / lines", toggle: false, host: "display", views: ["3d", "top"],
  help: "Neighbours further apart in distance than this are not connected (object edges).",
  params: [
    { k: "jump", label: "Break at jump", min: 0.05, max: 3, step: 0.05, unit: " m" },
    { k: "jumpRel", label: "Jump growth", min: 0, max: 0.1, step: 0.005, pct: true } ],
  defaults: { jump: 0.5, jumpRel: 0.02 },
  auto: "tuned", preset: true,
};
