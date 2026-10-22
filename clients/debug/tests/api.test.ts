import { describe, expect, it, vi } from "vitest";
import { Api, ApiError } from "../src/api/client";
import { FrameStream } from "../src/api/stream";
import { Problems } from "../src/ui/problems";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api client", () => {
  it("parses frames and their meta", async () => {
    const data = new Float32Array([1, 2, 3]);
    const fetchFn = vi.fn(async () => new Response(data.buffer, { headers: { "X-Meta": JSON.stringify({ id: 7, layers: 1, beams: 1 }) } }));
    const f = await new Api("/api", fetchFn as unknown as typeof fetch).frame(3);
    expect(fetchFn).toHaveBeenCalledWith("/api/frame?after=3", expect.anything());
    expect(f!.meta.id).toBe(7);
    expect(Array.from(f!.data)).toEqual([1, 2, 3]);
  });

  it("returns null for an empty long-poll answer", async () => {
    const api = new Api("/api", (async () => new Response(new ArrayBuffer(0), { headers: { "X-Meta": "{}" } })) as unknown as typeof fetch);
    expect(await api.frame(0)).toBeNull();
  });

  it("maps server errors to short ApiErrors", async () => {
    const api = new Api("/api", (async (url: string) =>
      String(url).includes("control") ? json({ detail: [{ msg: "x" }] }, 422) : json({ error: "offline" }, 400)) as unknown as typeof fetch);
    await expect(api.recordings()).rejects.toEqual(new ApiError("offline", 400));
    await expect(api.control("seek", 1)).rejects.toEqual(new ApiError("not replaying", 400));   // no session
    api.session = "s1";
    await expect(api.control("fly" as never)).rejects.toThrow("invalid request");
  });

  it("replays in a session of its own, which it ends when it goes back to live", async () => {
    const calls: [string, string][] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? "GET", String(url)]);
      return String(url).endsWith("/sessions") ? json({ id: "s1" }) : json({ source: String(url).includes("session=s1") ? "replay" : "live" });
    });
    const api = new Api("/api", fetchFn as unknown as typeof fetch);
    expect((await api.replay("walk.tpc")).source).toBe("replay");
    await api.control("seek", 12);
    expect(fetchFn).toHaveBeenCalledWith("/api/sessions/s1/control", expect.objectContaining({ method: "POST", body: '{"action":"seek","value":12}' }));
    await api.frame(0).catch(() => {});
    expect(calls.at(-1)![1]).toBe("/api/frame?after=0&session=s1");
    expect((await api.live()).source).toBe("live");
    expect(calls).toContainEqual(["DELETE", "/api/sessions/s1"]);
  });

  it("opens the server's default session first, and falls back to live when it ended", async () => {
    let ended = false;
    const fetchFn = vi.fn(async (url: string) => String(url).includes("session=d")
      ? (ended ? json({ error: "not found: session d" }, 404) : json({ source: "replay", session: "d" }))
      : json({ source: "live", default_session: ended ? null : "d" }));
    const api = new Api("/api", fetchFn as unknown as typeof fetch);
    expect((await api.state()).source).toBe("replay");
    ended = true;
    expect((await api.state()).source).toBe("live");
    expect(api.session).toBeNull();
  });
});

describe("frame stream", () => {
  it("delivers new frames, retries with backoff and reports once", async () => {
    const frames = [new Error("Failed to fetch"), new Error("Failed to fetch"), { meta: { id: 1 }, data: new Float32Array() },
                    { meta: { id: 1 }, data: new Float32Array() }, { meta: { id: 2 }, data: new Float32Array() }];
    const api = { frame: vi.fn(async () => { const f = frames.shift(); if (f instanceof Error) throw f; return f; }) };
    const got: number[] = [], sleeps: number[] = [], log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const problems = new Problems(() => {}, log);
    const s = new FrameStream(api as never, f => got.push(f.meta.id), problems.for("server"), async ms => { sleeps.push(ms); });
    await s.run(5);
    expect(got).toEqual([1, 2]);                              // duplicate id 1 skipped
    expect(sleeps).toEqual([1000, 1500]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("[server] ok again");
    expect(s.retryMs).toBe(1000);
  });
});

describe("problems", () => {
  it("one line per problem, panel text, flash clears", async () => {
    vi.useFakeTimers();
    const lines: string[][] = [], log = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
    const p = new Problems(l => lines.push(l), log);
    p.fail("server", new Error("Failed to fetch"));
    p.fail("server", new Error("Failed to fetch"));
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(p.lines()[0]).toMatch(/unreachable/);
    p.flash("action", "not replaying", 1000);
    expect(p.has("action")).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(p.has("action")).toBe(false);
    p.ok("server");
    expect(p.lines()).toEqual([]);
    vi.useRealTimers();
  });
});
