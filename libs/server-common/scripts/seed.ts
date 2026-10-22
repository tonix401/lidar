// bun scripts/seed.ts <database> '<json object>': write these settings into a server's database before it starts
// (testing.ts runs it in a child process, so a page's tests need no Bun types).
import { seedSettings } from "../src/settings";

const [path, json] = Bun.argv.slice(2);
if (!path || !json) { console.error("usage: seed.ts <database> '<json object>'"); process.exit(2); }
seedSettings(path, JSON.parse(json));
