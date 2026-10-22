// bun proc-servers/object-detection/scripts/empty-db.ts: write empty.db anew from the defaults (store.ts), without a
// name: a server's name is its database file's. It is committed: a new settings database (data/<name>.db) starts as a
// copy of it. Run it after changing the defaults (tests/objects.test.ts checks they agree).
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { writeEmpty } from "@mrs6000/server-common/settings";
import { defaults } from "../src/store";

const path = resolve(import.meta.dir, "../empty.db");
const { name: _, ...values } = defaults("");
rmSync(path, { force: true });
writeEmpty(path, values);
console.log(`wrote ${path}`);
