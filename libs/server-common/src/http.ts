// What every server's HTTP API shares: JSON replies, request bodies, the error → status mapping, the built web page
// at /, and the guard against other web sites: a browser sends any page's requests to a server on localhost, so a
// state-changing request (or a WebSocket upgrade) carrying an Origin that is not the server's own, or one listed
// with --allow-origin, is refused. Requests without an Origin (curl, the other servers) are not browsers'.
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describeError, NotFoundError, ValueError } from "./errors";
import { log } from "./log";

/** a request body that does not have the expected shape: HTTP 422 */
export class InvalidRequest extends Error { override name = "InvalidRequest"; }
/** a change without the admin token: HTTP 401 */
export class Unauthorized extends Error { override name = "Unauthorized"; }
/** a request from another web site: HTTP 403 */
export class Forbidden extends Error { override name = "Forbidden"; }

export const json = (obj: unknown, status = 200): Response => Response.json(obj, { status });

/** a JSON object body; only with Content-Type application/json (a cross-site form post cannot send that) */
export async function body(req: Request): Promise<Record<string, unknown>> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new InvalidRequest("expected Content-Type: application/json");
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  } catch { /* below */ }
  throw new InvalidRequest("expected a JSON object");
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new InvalidRequest(`${what}: one of ${allowed.join(", ")}`);
  return v as T;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** is this request from the server's own page, an allowed origin, or not from a browser at all? */
export function fromAllowedOrigin(req: Request, allowed: readonly string[] = []): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  return origin === new URL(req.url).origin || allowed.includes(origin);
}

/** refuse a state-changing request from another web site */
export function guard(req: Request, allowed: readonly string[] = []): void {
  if (!SAFE.has(req.method) && !fromAllowedOrigin(req, allowed)) throw new Forbidden(`requests from ${req.headers.get("origin")} are not allowed`);
}

/** "Authorization: Bearer <token>" once a token is set */
export function needToken(req: Request, token: string | undefined): void {
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) throw new Unauthorized("this needs the admin token");
}

/** an error as its HTTP reply */
export function errorResponse(e: unknown, what: string): Response {
  if (e instanceof InvalidRequest) return json({ error: e.message }, 422);
  if (e instanceof Unauthorized) return json({ error: e.message }, 401);
  if (e instanceof Forbidden) return json({ error: e.message }, 403);
  if (e instanceof ValueError) return json({ error: e.message || "ValueError" }, 400);
  if (e instanceof NotFoundError) return json({ error: `not found: ${e.message}` }, 404);
  const msg = describeError(e);
  log(`http ${what}: ${msg}`);
  return json({ error: msg }, 500);
}

/** the built web page in `dir` (index.html at /); `missing` is shown at / when it is not built */
export function staticFiles(dir: string | null | undefined, missing: string): (url: URL) => Response {
  const front = dir && existsSync(join(dir, "index.html")) ? resolve(dir) : null;
  return url => {
    if (!front) return url.pathname === "/" ? new Response(missing, { headers: { "Content-Type": "text/html; charset=utf-8" } }) : json({ error: "not found" }, 404);
    let path = resolve(front, "." + decodeURIComponent(url.pathname));
    if (path !== front && !path.startsWith(front + sep)) return json({ error: "not found" }, 404);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
    if (!existsSync(path)) return json({ error: "not found" }, 404);
    return new Response(Bun.file(path));
  };
}

/** the page shown when a web page is not built */
export const notBuilt = (title: string, dir: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font:14px system-ui;background:#0e1116;color:#d7dde5;padding:2em">
<h1>${title}: page not built</h1><p>Run <code>make build</code> (or <code>cd ${dir} && bun run build</code>).</p>`;
