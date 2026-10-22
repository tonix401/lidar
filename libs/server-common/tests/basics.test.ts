// Short error messages, health logging and loop supervision.
import { describe, expect, it } from "vitest";
import { ConnectionError, describeError, ValueError } from "../src/errors";
import { Health, Stop, supervised } from "../src/health";
import { Forbidden, fromAllowedOrigin, guard, knownHost } from "../src/http";
import { hostname } from "node:os";

describe("errors", () => {
  const sys = (code: string, extra = {}) => Object.assign(new Error(`${code}: something`), { code, ...extra });
  it("network errors are short", () => {
    expect(describeError(sys("ETIMEDOUT"))).toBe("timed out");
    expect(describeError(new DOMException("The operation timed out.", "TimeoutError"))).toBe("timed out");
    expect(describeError(sys("ECONNREFUSED"))).toBe("connection refused");
    expect(describeError(sys("ECONNRESET"))).toBe("connection reset");
    expect(describeError(sys("ENOTFOUND"))).toBe("host not found");
  });
  it("fetch failures unwrap their cause", () => {
    expect(describeError(new TypeError("fetch failed", { cause: sys("ECONNREFUSED") }))).toBe("connection refused");
  });
  it("file errors show only the file name", () => {
    expect(describeError(sys("ENOENT", { path: "/very/long/path/to/file.mrsstream" }))).toBe("no such file or directory: file.mrsstream");
  });
  it("other errors keep their type and first line, capped", () => {
    expect(describeError(new TypeError("bad\nsecond line"))).toBe("TypeError: bad");
    expect(describeError(new ConnectionError("sensor closed connection"))).toBe("sensor closed connection");
    expect(describeError(new ValueError("scan layout changed"))).toBe("scan layout changed");
    expect(describeError(new RangeError())).toBe("RangeError");
    expect(describeError(new TypeError("x".repeat(500))).length).toBe(120);
  });
});

describe("health", () => {
  it("logs once per problem and on recovery", () => {
    const lines: string[] = [], h = new Health("sensor", 3, l => lines.push(l));
    for (let k = 0; k < 5; k++) expect(h.fail(Object.assign(new Error(), { code: "ECONNREFUSED" }))).toBe("connection refused");
    h.fail("timed out"); h.ok(); h.ok();
    expect(lines).toEqual(["sensor: connection refused (retrying every 3 s)", "sensor: timed out (retrying every 3 s)", "sensor: ok again"]);
  });

  it("reminds while a problem persists", () => {
    const lines: string[] = [], h = new Health("x", null, l => lines.push(l));
    h.remindS = 0;
    h.fail("down"); h.fail("down");
    expect(lines[0]).toBe("x: down");
    expect(lines[1]).toMatch(/^x: still failing after/);
  });

  it("supervised restarts a crashing loop", async () => {
    const stop = new Stop(), lines: string[] = [];
    let calls = 0;
    await supervised("worker", async () => {
      if (++calls >= 3) { stop.set(); return; }
      throw new Error("boom");
    }, stop, 0.01, l => lines.push(l));
    expect(calls).toBe(3);
    expect(lines).toContain("worker: crashed (boom), restarting");
  });
});

describe("guards", () => {
  const req = (url: string, h: Record<string, string> = {}, method = "GET") => new Request(url, { method, headers: h });
  it("a request must name the server by one of its names", () => {
    for (const ok of ["http://localhost:8000/api", "http://127.0.0.1:8000/api", "http://[::1]:8000/api", `http://${hostname()}:8000/api`, "http://x.localhost/api"])
      expect(knownHost(req(ok))).toBe(true);
    expect(knownHost(req("http://evil.example:8000/api"))).toBe(false);
    expect(knownHost(req("http://box.lan:8000/api"), ["http://box.lan:8000"])).toBe(true);
  });
  it("same origin counts only under a name of its own (DNS rebinding)", () => {
    expect(fromAllowedOrigin(req("http://127.0.0.1:8000/api", { Origin: "http://127.0.0.1:8000" }))).toBe(true);
    expect(fromAllowedOrigin(req("http://evil.example:8000/api", { Origin: "http://evil.example:8000" }))).toBe(false);
    expect(() => guard(req("http://evil.example:8000/api"))).toThrow(Forbidden);                       // reading too
    expect(() => guard(req("http://localhost:8000/api", { Origin: "http://evil.example" }, "POST"))).toThrow(Forbidden);
    expect(() => guard(req("http://localhost:8000/api", { Origin: "http://localhost:8000" }, "POST"))).not.toThrow();
  });
});
