// The pipeline stages in panel order, and the settings they make up. Each stage's title, help,
// parameters, defaults and auto/preset role live in its own module (StageDef).
import { objectsStage, type ObjectsConfig } from "../objects/detector";
import { spatialStage, type SpatialConfig } from "../pipeline/bilateral";
import { cellsStage, type CellsConfig } from "../pipeline/cells";
import { dynamicStage, type DynamicConfig } from "../pipeline/dynsmooth";
import { historyStage, type HistoryConfig } from "../pipeline/history";
import { intensityStage, type IntensityConfig } from "../pipeline/intensity";
import { layercalStage, type LayercalConfig } from "../pipeline/layercal";
import { adaptiveStage, type AdaptiveConfig } from "../pipeline/motion";
import { outlierStage, type OutlierConfig } from "../pipeline/outlier";
import { outlineStage, type OutlineConfig } from "../pipeline/outline";
import { planesStage, type PlanesConfig } from "../pipeline/planes";
import { temporalStage, type TemporalConfig } from "../pipeline/temporal";
import { wallsStage, type WallsConfig } from "../pipeline/wall";
import { meshStage, type MeshConfig } from "./mesh";
import type { StageDef } from "./types";

/** every tunable of the processing pipeline, one slice per stage */
export interface Config {
  intensity: IntensityConfig;
  layercal: LayercalConfig;
  adaptive: AdaptiveConfig;
  outlier: OutlierConfig;
  temporal: TemporalConfig;
  history: HistoryConfig;
  spatial: SpatialConfig;
  dynamic: DynamicConfig;
  cells: CellsConfig;
  planes: PlanesConfig;
  mesh: MeshConfig;
  outline: OutlineConfig;
  walls: WallsConfig;
  objects: ObjectsConfig;
}
export type StageKey = keyof Config;

export const STAGES: StageDef[] = [
  intensityStage, layercalStage, adaptiveStage, outlierStage, temporalStage, historyStage, spatialStage, dynamicStage,
  cellsStage, planesStage, objectsStage, outlineStage, wallsStage, meshStage,
];

export const stageDef = (key: StageKey): StageDef => STAGES.find(s => s.key === key)!;

export function defaultConfig(): Config {
  return Object.fromEntries(STAGES.map(s => [s.key, structuredClone(s.defaults)])) as unknown as Config;
}
