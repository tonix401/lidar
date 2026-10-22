// Short, human-readable error messages (one line, no stack trace), and the error types the HTTP API maps to
// status codes.

/** bad input (a request, a file): HTTP 400 */
export class ValueError extends Error { override name = "ValueError"; }
/** a recording, sensor or session that is not there: HTTP 404 */
export class NotFoundError extends Error { override name = "NotFoundError"; }
/** the connection to a device failed or closed (its message says what happened) */
export class ConnectionError extends Error { override name = "ConnectionError"; }

const BY_CODE: Record<string, string> = {
  ETIMEDOUT: "timed out", ConnectionTimeout: "timed out", TimeoutError: "timed out",
  ECONNREFUSED: "connection refused", ConnectionRefused: "connection refused",
  ECONNRESET: "connection reset", EPIPE: "connection reset", ConnectionClosed: "connection reset",
  ENOTFOUND: "host not found", EAI_AGAIN: "host not found", EAI_NONAME: "host not found",
  EHOSTUNREACH: "host unreachable", ENETUNREACH: "network unreachable",
  ENOENT: "no such file or directory", EACCES: "permission denied", EPERM: "operation not permitted",
  ENOSPC: "no space left on device", EEXIST: "file exists", EISDIR: "is a directory", ENOTDIR: "not a directory",
  EROFS: "read-only file system", EADDRINUSE: "address already in use", EADDRNOTAVAIL: "address not available",
};

/** errors whose message already says what happened: shown without their type */
const PLAIN = new Set(["Error", "ConnectionError", "ValueError", "NotFoundError"]);

/** one short line for an error, e.g. "connection refused" or "timed out" */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return cap(String(e).split("\n")[0].trim() || "error");
  const err = e as Error & { code?: string; path?: string };
  const known = (err.code && BY_CODE[err.code]) || BY_CODE[err.name];
  if (known) return err.path ? `${known}: ${basename(err.path)}` : known;
  if (err.cause instanceof Error && err.message === "fetch failed") return describeError(err.cause);
  const msg = err.message.trim().split("\n")[0] ?? "";
  return cap(msg && PLAIN.has(err.name) ? msg : msg ? `${err.name}: ${msg}` : err.name);
}

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const cap = (s: string) => (s.length <= 120 ? s : s.slice(0, 117) + "...");
