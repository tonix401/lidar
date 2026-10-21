// The model, short error messages, health logging and loop supervision, the REST client.
import { describe, expect, it } from "vitest";
import { ConnectionError, describeError, ValueError } from "../src/errors";
import { Health, Stop, supervised } from "../src/health";
import { beamCount, elevations, points } from "../src/model";
import { RestClient, RestError } from "../src/rest";
import { FakeRest, freePort, makeScan, STATUS_VALUES } from "./helpers";

describe("model", () => {
  it("layer angles and counts", () => {
    const layer = makeScan(2, 4).layers[0];
    expect(beamCount(layer)).toBe(4);
    expect(elevations(layer)[1]).toBeCloseTo(-5 + 0.01, 12);
  });

  it("point geometry; upside down flips only z", () => {
    const scan = makeScan(1, 1, () => 2000), [[x, y, z, d, , li, ei]] = [...points(scan)];
    const az = -60 * Math.PI / 180, el = -5 * Math.PI / 180;
    expect(x).toBeCloseTo(Math.cos(az) * Math.cos(el) * 2, 12);
    expect(y).toBeCloseTo(Math.sin(az) * Math.cos(el) * 2, 12);
    expect(z).toBeLessThan(0); expect(d).toBe(2); expect([li, ei]).toEqual([0, 0]);
    const [[x2, y2, z2]] = [...points(scan, null, true)];
    expect([x2, y2, z2]).toEqual([x, y, -z]);
  });

  it("points skip invalid returns and filter by echo", () => {
    const scan = makeScan(1, 3, (_l, b) => (b === 1 ? 0 : 1000));
    expect([...points(scan)].length).toBe(2);
    expect([...points(scan, 1)]).toEqual([]);
  });
});

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

describe("REST client", () => {
  const withRest = async (f: (r: FakeRest) => Promise<void>) => { const r = new FakeRest({ ...STATUS_VALUES }); try { await f(r); } finally { r.close(); } };

  it("get and errors", () => withRest(async fake => {
    const rest = new RestClient("", 5, fake.url);
    expect(await rest.get("KM_SysBoard_Temp")).toBe(41.5);
    await expect(rest.get("NoSuchVariable")).rejects.toBeInstanceOf(RestError);
  }));

  it("getMany reports rejected variables in place", () => withRest(async fake => {
    const out = await new RestClient("", 5, fake.url).getMany(["UpsideDown", "NoSuchVariable"]);
    expect(out.UpsideDown).toBe(true);
    expect(String(out.NoSuchVariable)).toMatch(/^<error:/);
  }));

  it("getMany throws at once on connection errors", async () => {
    const rest = new RestClient("", 1, `http://127.0.0.1:${await freePort()}/api/`);
    await expect(rest.getMany(["A", "B", "C"])).rejects.toThrow();
  });

  it("login and an authenticated write", () => withRest(async fake => {
    const rest = new RestClient("", 5, fake.url);
    expect(await rest.login("Service", "wrong")).toBe(false);
    expect(rest.user).toBe("Run");
    expect(await rest.login("Service", "servicelevel")).toBe(true);
    await rest.write("LocationName", "lab");
    expect(fake.values.LocationName).toBe("lab");
  }));

  it("a salted challenge response differs", () => {
    const ch = { realm: "R", nonce: "N" };
    const a = RestClient.challengeResponse("u", "p", ch, "X"), b = RestClient.challengeResponse("u", "p", { ...ch, salt: [1, 2] }, "X");
    expect(a.length).toBe(64);
    expect(a).not.toBe(b);
  });
});
