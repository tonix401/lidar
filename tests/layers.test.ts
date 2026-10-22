// The projects are independent: each imports only the libraries (libs/) and its own files, never another project,
// and the libraries never import a project. libs/processing and libs/wire depend on no other part of the repo;
// libs/server-common on those two, libs/web (what the pages share) on libs/wire. The pages (clients/) use the server
// libraries only in their tests.
// Run with `bun test tests` (make test does).
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PROJECTS = ["source-server", "proc-servers/debug", "proc-servers/object-detection", "clients/debug", "clients/object-detection"];
const LIBS: Record<string, string[]> = { processing: [], wire: [], "server-common": ["processing", "wire"], web: ["wire"] };
const SKIP = new Set(["node_modules", "dist", "artifacts", "cache", "config"]);

function* tsFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* tsFiles(p);
    else if (/\.ts$/.test(name) && !name.endsWith(".d.ts")) yield p;
  }
}

/** every module a file imports: specifiers of import/export … from, import(), and worker URLs */
function imports(file: string): string[] {
  const src = readFileSync(file, "utf8"), out: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"'\n;]*?(?:from\s*)?["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g)) out.push(m[1]);
  return out;
}

/** the part of the repo a resolved path is in: a project, libs/<name>, or "outside" */
function partOf(path: string): string {
  const rel = relative(ROOT, path).split(sep).join("/");
  for (const p of PROJECTS) if (rel === p || rel.startsWith(p + "/")) return p;
  const lib = rel.match(/^libs\/([^/]+)/);
  return lib ? `libs/${lib[1]}` : "outside";
}

function violations(part: string, allowedLibs: (file: string) => string[]): string[] {
  const bad: string[] = [];
  for (const file of tsFiles(join(ROOT, part))) {
    for (const spec of imports(file)) {
      const where = `${relative(ROOT, file)}: ${spec}`;
      if (spec.startsWith(".")) {
        const target = partOf(resolve(dirname(file), spec));
        if (target !== part) bad.push(`${where} (reaches into ${target})`);
      } else if (spec.startsWith("@mrs6000/")) {
        const lib = spec.slice("@mrs6000/".length).split("/")[0];
        if (!allowedLibs(file).includes(lib)) bad.push(`${where} (not a library it may use)`);
      }
    }
  }
  return bad;
}

const inTests = (file: string) => /\/(tests|e2e|scripts)\//.test(file);

describe("independent projects", () => {
  for (const p of PROJECTS) {
    it(`${p} imports only the libraries`, () => {
      const allowed = (file: string) => p.startsWith("clients/") && !inTests(file) ? ["processing", "wire", "web"] : Object.keys(LIBS);
      expect(violations(p, allowed)).toEqual([]);
    });
  }
  for (const [lib, deps] of Object.entries(LIBS)) {
    it(`libs/${lib} imports ${deps.length ? deps.join(" and ") : "no other part of the repo"}`, () => {
      expect(violations(`libs/${lib}`, () => [lib, ...deps])).toEqual([]);
    });
  }
});
