// A recording's fused tracks, the same to the byte on every run: every sensor on the main thread, every frame in order
// (pull mode) from a source server of its own, the default settings, the recording's own rig. One JSON line per scan
// set, as the track cache stores them. For checking that a change to the servers left the tracks alone:
//   bun proc-servers/object-detection/scripts/tracks.ts sim_rig3 /tmp/before.jsonl     (then after the change, cmp)
//   bun proc-servers/object-detection/scripts/tracks.ts NAME OUT [RECORDINGS_DIR]       (default: recordings/)
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "@mrs6000/processing/config/config";
import { SourcePipeline } from "@mrs6000/server-common/pipeline";
import { startSource } from "@mrs6000/server-common/testing";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [name, out, recordings = resolve(REPO, "recordings")] = process.argv.slice(2);
if (!name || !out) { console.error("usage: tracks.ts RECORDING OUT.jsonl [RECORDINGS_DIR]"); process.exit(2); }

const source = await startSource(resolve(recordings)), lines: string[] = [];
try {
  await new Promise<void>((done, fail) => {
    const p = new SourcePipeline({ url: source.url, name: "tracks" }, { kind: "replay", recording: name, mode: "pull" }, defaultConfig(), {
      objects: t => lines.push(JSON.stringify(t)), end: () => { p.close(); done(); }, error: e => fail(new Error(e)), closed: r => fail(new Error(r)),
    }, { threaded: false });
  });
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${name}: ${lines.length} scan sets → ${out}`);
} finally {
  source.stop();
}
