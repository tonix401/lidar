// bun source-server/scripts/migrate-sessions.ts <recordings folder>: sessions recorded before 2026-10-22 kept their
// sensors, order and poses in a session.json; now each file's header holds them (src/recording/format.ts,
// RecordingMeta). This writes them into the headers and removes the session.json. Running it again does nothing.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RigSensor } from "@mrs6000/wire/rig";
import { Recording, rewriteHeader } from "../src/recording/reader";
import { rigEntry } from "../src/recording/session";

interface OldSession {
  sensors: { name: string; file: string }[]; rig?: { sensors?: RigSensor[] }; created?: number;
  truth?: { name: string; pose: NonNullable<RigSensor["pose"]> }[];
}

const dir = Bun.argv[2];
if (!dir) { console.error("usage: migrate-sessions.ts <recordings folder>"); process.exit(2); }
for (const name of readdirSync(dir)) {
  const folder = join(dir, name), json = join(folder, "session.json");
  if (!statSync(folder).isDirectory() || !existsSync(json)) continue;
  const old = JSON.parse(readFileSync(json, "utf8")) as OldSession;
  const rig = new Map((old.rig?.sensors ?? []).map(s => [s.name, s])), truth = new Map((old.truth ?? []).map(t => [t.name, t.pose]));
  for (const [index, s] of old.sensors.entries()) {
    const rec = new Recording(join(folder, s.file));
    try {
      await rewriteHeader(rec, { ...rec.hdr, sensor: s.name }, {
        ...rec.meta, index, ...(old.created !== undefined ? { created: old.created } : {}), rig: rigEntry(rig.get(s.name)),
        ...(truth.has(s.name) ? { truth: truth.get(s.name) } : {}),
      });
    } finally {
      rec.close();
    }
  }
  rmSync(json);
  console.log(`${name}: ${old.sensors.length} sensors, session.json moved into their headers`);
}
