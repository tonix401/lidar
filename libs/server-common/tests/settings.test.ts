// The settings database, the fields a page edits, and moving where a server listens.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingField } from "@mrs6000/wire/settings";
import { describe, expect, it } from "vitest";
import { Listener } from "../src/listener";
import { changedKeys, checkPatch, loadSettings, seedSettings, setPath, SettingsDb, settingsView, writeEmpty } from "../src/settings";

const dir = () => mkdtempSync(join(tmpdir(), "settings-"));

describe("settings database", () => {
  it("defaults on a new database, saved and loaded again", () => {
    const path = join(dir(), "sub", "a.db");
    const s = loadSettings(new SettingsDb(path), { port: 8000, origins: [] as string[] });
    expect(s).toEqual({ port: 8000, origins: [] });
    const db = new SettingsDb(path);
    db.save({ port: 8100, origins: ["http://x"], source: { url: "http://s:1" } });
    db.close();
    expect(loadSettings(new SettingsDb(path), { port: 8000, origins: [], extra: true })).toEqual({ port: 8100, origins: ["http://x"], extra: true });
  });
  it("a key left out is removed", () => {
    const db = new SettingsDb(null);
    db.save({ a: 1, b: 2 });
    db.save({ a: 3 });
    expect(db.load()).toEqual({ a: 3 });
  });
  it("a new database starts as a copy of the template; an existing one is never replaced", () => {
    const d = dir(), template = join(d, "empty.db"), path = join(d, "data", "a.db");
    writeEmpty(template, { port: 9000, open: true });
    expect(loadSettings(new SettingsDb(path, template), { port: 1, open: false, host: "x" })).toEqual({ port: 9000, open: true, host: "x" });
    const db = new SettingsDb(path, template);
    db.save({ port: 9100 });
    db.close();
    writeEmpty(template, { port: 9999 });
    expect(loadSettings(new SettingsDb(path, template), { port: 1 }).port).toBe(9100);    // its own from now on
    expect(loadSettings(new SettingsDb(join(d, "b.db"), join(d, "missing.db")), { port: 1 }).port).toBe(1);   // no template: the defaults
  });
  it("seeded before a server starts", () => {
    const path = join(dir(), "a.db");
    seedSettings(path, { port: 0 });
    expect(loadSettings(new SettingsDb(path), { port: 8000, host: "127.0.0.1" })).toEqual({ port: 0, host: "127.0.0.1" });
  });
});

describe("settings fields", () => {
  const F: SettingField[] = [
    { key: "port", label: "Port", type: "port" }, { key: "source.url", label: "Source", type: "url" },
    { key: "open", label: "Open", type: "bool" }, { key: "origins", label: "Origins", type: "lines" },
    { key: "max", label: "Max", type: "number", min: 1, max: 8 }, { key: "replay", label: "Replay", type: "select", options: ["", "a"] },
    { key: "processing", label: "Processing", type: "json" },
  ];
  it("values by their path", () => {
    expect(settingsView(F, { port: 1, source: { url: "http://a" } }).values).toMatchObject({ port: 1, "source.url": "http://a", open: undefined });
    const o = { source: { url: "x", token: "t" } };
    setPath(o, "source.url", "y");
    expect(o).toEqual({ source: { url: "y", token: "t" } });
  });
  it("checked and normalised", () => {
    expect(checkPatch(F, { port: "8100", "source.url": " http://s:8000/ ", origins: "http://a\n\n http://b ", max: 3, replay: "" }))
      .toEqual({ port: 8100, "source.url": "http://s:8000", origins: ["http://a", "http://b"], max: 3, replay: "" });
  });
  it("refused with the field's name", () => {
    expect(() => checkPatch(F, { nope: 1 })).toThrow("unknown setting nope");
    expect(() => checkPatch(F, { port: 70000 })).toThrow("Port: from 0 to 65535");
    expect(() => checkPatch(F, { port: 80.5 })).toThrow("Port: a whole number");
    expect(() => checkPatch(F, { "source.url": "ftp://x" })).toThrow("Source: an http");
    expect(() => checkPatch(F, { open: "yes" })).toThrow("Open: true or false");
    expect(() => checkPatch(F, { max: 9 })).toThrow("Max: from 1 to 8");
    expect(() => checkPatch(F, { replay: "b" })).toThrow("Replay: one of");
    expect(() => checkPatch(F, { processing: [] })).toThrow("Processing: a JSON object");
  });
  it("what changed", () => {
    expect(changedKeys({ port: 1, "source.url": "http://a", origins: [] }, { port: 1, source: { url: "http://b" }, origins: [] })).toEqual(["source.url"]);
  });
});

describe("listener", () => {
  const serve = (at: { host: string; port: number }) => Bun.serve({ hostname: at.host, port: at.port, fetch: () => new Response("ok") });
  it("moves to another port; a taken one leaves it where it was", async () => {
    const l = new Listener(serve, { host: "127.0.0.1", port: 0 }), first = l.at.port;
    expect(await (await fetch(`http://127.0.0.1:${first}`)).text()).toBe("ok");
    const other = serve({ host: "127.0.0.1", port: 0 });
    expect(() => l.move({ host: "127.0.0.1", port: other.port! })).toThrow("cannot listen");
    expect(l.at.port).toBe(first);
    other.stop(true);
    l.move({ host: "127.0.0.1", port: 0 });
    expect(l.at.port).not.toBe(first);
    expect(await (await fetch(`http://127.0.0.1:${l.at.port}`)).text()).toBe("ok");
    await new Promise(r => setTimeout(r, 700));
    await expect(fetch(`http://127.0.0.1:${first}`)).rejects.toThrow();
    l.stop();
  });
});
