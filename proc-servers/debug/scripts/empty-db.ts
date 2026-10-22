// bun proc-servers/debug/scripts/empty-db.ts: write empty.db anew from the defaults (store.ts). It is committed: a new
// settings database starts as a copy of it. Run it after changing DEFAULTS (tests/store.test.ts checks they agree).
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { writeEmpty } from "@mrs6000/server-common/settings";
import { DEFAULTS } from "../src/store";

const path = resolve(import.meta.dir, "../empty.db");
rmSync(path, { force: true });
writeEmpty(path, { ...DEFAULTS });
console.log(`wrote ${path}`);
