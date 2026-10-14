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
      String(url).includes("control") ? json({ detail: [{ msg: "x" }] }, 422) : json({ error: "not replaying" }, 400)) as unknown as typeof fetch);
    await expect(api.live()).rejects.toEqual(new ApiError("not replaying", 400));
    await expect(api.control("fly" as never)).rejects.toThrow("invalid request");
  });

  it("sends JSON bodies and builds download urls", async () => {
    const fetchFn = vi.fn(async () => json({ source: "replay" }));
    const api = new Api("/api", fetchFn as unknown as typeof fetch);
    await api.control("seek", 12);
    expect(fetchFn).toHaveBeenCalledWith("/api/replay/control", expect.objectContaining({ method: "POST", body: '{"action":"seek","value":12}' }));
    expect(api.downloadUrl("a b.mrsstream")).toBe("/api/recordings/a%20b.mrsstream");
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
