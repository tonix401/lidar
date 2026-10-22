// @vitest-environment happy-dom
// The settings form: drawn from the server's fields, Save sends only what changed, a refusal is shown, and the page
// follows a server that moved.
import type { SettingsSaved, SettingsView } from "@mrs6000/wire/settings";
import { describe, expect, it } from "vitest";
import { fromInput, movedUrl, SettingsForm, toInput } from "../src/settingsForm";

const VIEW: SettingsView = {
  fields: [
    { key: "host", label: "Address", type: "text", group: "Network" }, { key: "port", label: "Port", type: "port", group: "Network" },
    { key: "open", label: "Open", type: "bool", group: "Access" }, { key: "origins", label: "Origins", type: "lines", group: "Access" },
    { key: "adminToken", label: "Admin token", type: "secret", group: "Access" }, { key: "processing", label: "Processing", type: "json" },
  ],
  values: { host: "127.0.0.1", port: 8000, open: true, origins: ["http://a"], adminToken: "", processing: { a: 1 } },
};

const tick = () => new Promise(r => setTimeout(r, 0));
const set = (form: SettingsForm, key: string, v: string | boolean) => {
  const i = form.el.querySelector<HTMLInputElement>(`[name="${key}"]`)!;
  if (typeof v === "boolean") i.checked = v; else i.value = v;
  i.dispatchEvent(new Event("input"));
};

describe("settings form", () => {
  it("values to inputs and back", () => {
    const [lines, json, port] = [VIEW.fields[3], VIEW.fields[5], VIEW.fields[1]];
    expect(toInput(lines, ["a", "b"])).toBe("a\nb");
    expect(fromInput(lines, " a \n\n b")).toEqual(["a", "b"]);
    expect(fromInput(json, toInput(json, { a: 1 }))).toEqual({ a: 1 });
    expect(() => fromInput(json, "{nope")).toThrow("Processing: not valid JSON");
    expect(fromInput(port, "8100")).toBe(8100);
  });

  it("groups the fields; Save sends only what changed and shows the answer", async () => {
    const sent: Record<string, unknown>[] = [], saved: unknown[] = [];
    const form = new SettingsForm({ load: async () => VIEW, save: async p => { sent.push(p); return { ...VIEW, values: { ...VIEW.values, ...p } }; } },
                                  { onSaved: (_, p) => saved.push(p) });
    await form.load();
    expect([...form.el.querySelectorAll("legend")].map(l => l.textContent)).toEqual(["Network", "Access"]);
    const save = form.el.querySelector<HTMLButtonElement>(".primary")!;
    expect(save.disabled).toBe(true);
    set(form, "port", "8100"); set(form, "open", false);
    expect([save.disabled, save.textContent]).toEqual([false, "Save 2 changes"]);
    set(form, "processing", "{oops");
    expect([save.disabled, form.el.querySelector(".sf-status")!.textContent]).toEqual([true, "Processing: not valid JSON"]);
    set(form, "processing", '{"a": 1}');                                      // the same object again: no change
    save.click();
    await tick();
    expect(sent).toEqual([{ port: 8100, open: false }]);
    expect(saved).toEqual([{ port: 8100, open: false }]);
    expect(form.el.querySelector<HTMLInputElement>('[name="port"]')!.value).toBe("8100");
    expect(save.disabled).toBe(true);
  });

  it("a refusal is shown and the edits stay", async () => {
    const form = new SettingsForm({ load: async () => VIEW, save: async () => { throw new Error("Port: from 0 to 65535"); } });
    await form.load();
    set(form, "port", "99999");
    form.el.querySelector<HTMLButtonElement>(".primary")!.click();
    await tick();
    expect(form.el.querySelector(".sf-error")!.textContent).toBe("Port: from 0 to 65535");
    expect(form.el.querySelector<HTMLInputElement>('[name="port"]')!.value).toBe("99999");
  });

  it("a load that is refused says why", async () => {
    const form = new SettingsForm({ load: async () => { throw new Error("this needs the admin token"); }, save: async () => ({} as SettingsSaved) });
    await form.load();
    expect(form.el.querySelector(".sf-error")!.textContent).toBe("this needs the admin token");
  });

  it("where the page goes after the server moved", () => {
    const here = { protocol: "http:", hostname: "box.lan", pathname: "/", search: "?x=1" };
    expect(movedUrl(here, { host: "0.0.0.0", port: 8100 })).toBe("http://box.lan:8100/?x=1");
    expect(movedUrl(here, { host: "10.0.0.5", port: 8100 })).toBe("http://10.0.0.5:8100/?x=1");
    expect(movedUrl(here, { host: "127.0.0.1", port: 8100 })).toBeNull();          // this machine only, page from another
    expect(movedUrl({ ...here, hostname: "localhost" }, { host: "127.0.0.1", port: 8100 })).toBe("http://localhost:8100/?x=1");
    expect(movedUrl(here, { host: "fe80::1", port: 8100 })).toBe("http://[fe80::1]:8100/?x=1");
  });
});
