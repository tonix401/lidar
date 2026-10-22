// A server's settings on its page (GET/PUT /api/settings, libs/wire/src/settings.ts): one form drawn from the fields
// the server describes, in their groups. Save sends only what changed; the server applies it at once and answers with
// the settings now. When the server moved (another address or port), the page follows it there.
import type { SettingField, SettingsSaved, SettingsView } from "@mrs6000/wire/settings";

export interface SettingsCalls {
  load(): Promise<SettingsView>;
  save(patch: Record<string, unknown>): Promise<SettingsSaved>;
}

export interface SettingsFormOptions {
  onSaved?(saved: SettingsSaved, patch: Record<string, unknown>): void;
  follow?: boolean;                          // go to the server's new address after it moved (default: true)
  navigate?(url: string): void;              // how (default: location.href)
}

type Input = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type Where = Pick<Location, "protocol" | "hostname" | "pathname" | "search">;

/** what a field's input shows for a value */
export function toInput(f: SettingField, v: unknown): string | boolean {
  if (f.type === "bool") return !!v;
  if (f.type === "lines") return Array.isArray(v) ? v.join("\n") : "";
  if (f.type === "json") return JSON.stringify(v ?? {}, null, 2);
  return v === undefined || v === null ? "" : String(v);
}

/** the value an input means (the server checks it; only JSON is parsed here) */
export function fromInput(f: SettingField, raw: string | boolean): unknown {
  if (f.type === "bool") return !!raw;
  const s = String(raw);
  if (f.type === "number" || f.type === "port") return s.trim() === "" ? s : Number(s);
  if (f.type === "lines") return s.split("\n").map(l => l.trim()).filter(Boolean);
  if (f.type === "json") {
    try { return JSON.parse(s); } catch { throw new Error(`${f.label}: not valid JSON`); }
  }
  return s;
}

const LOOPBACK = /^(localhost|127(\.\d+){3}|::1|\[::1\])$/;

/** where this page is once its server listens there; null when this browser cannot reach it (it now listens on this
 *  machine only, and the page is open from another) */
export function movedUrl(here: Where, moved: { host: string; port: number }): string | null {
  let host = moved.host;
  if (host === "0.0.0.0" || host === "::" || host === "") host = here.hostname;
  else if (LOOPBACK.test(host)) { if (!LOOPBACK.test(here.hostname)) return null; host = here.hostname; }
  else if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `${here.protocol}//${host}:${moved.port}${here.pathname}${here.search}`;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids);
  return e;
}

export class SettingsForm {
  readonly el = h("div", { className: "settings-form" });
  private view: SettingsView | null = null;
  private inputs = new Map<string, Input>();
  private error = h("div", { className: "sf-error", hidden: true });
  private status = h("span", { className: "sf-status" });
  private saveBtn = h("button", { type: "button", className: "primary", textContent: "Save", disabled: true });
  private discardBtn = h("button", { type: "button", textContent: "Discard", disabled: true });
  private body = h("div");

  constructor(private calls: SettingsCalls, private o: SettingsFormOptions = {}) {
    this.saveBtn.onclick = () => void this.save();
    this.discardBtn.onclick = () => this.render();
    this.el.append(this.error, this.body, h("div", { className: "sf-actions" }, this.saveBtn, this.discardBtn, this.status));
  }

  /** fetch the settings and draw them (a refusal, e.g. a missing admin token, is shown in the form) */
  async load(): Promise<void> {
    try {
      this.view = await this.calls.load();
      this.showError("");
      this.render();
    } catch (e) {
      this.view = null;
      this.body.replaceChildren();
      this.showError(e instanceof Error ? e.message : String(e));
      this.changed();
    }
  }

  /** the changed values, by key (throws for an input that is not valid JSON) */
  patch(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of this.view?.fields ?? []) {
      const input = this.inputs.get(f.key)!, now = fromInput(f, input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value);
      if (JSON.stringify(now) !== JSON.stringify(fromInput(f, toInput(f, this.view!.values[f.key])))) out[f.key] = now;
    }
    return out;
  }

  private render(): void {
    this.inputs.clear();
    const groups = new Map<string, SettingField[]>();
    for (const f of this.view?.fields ?? []) groups.set(f.group ?? "", [...(groups.get(f.group ?? "") ?? []), f]);
    this.body.replaceChildren(...[...groups].map(([g, fields]) =>
      h("fieldset", { className: "sf-group" }, ...(g ? [h("legend", { textContent: g })] : []), ...fields.map(f => this.field(f)))));
    this.changed();
  }

  private field(f: SettingField): HTMLElement {
    const v = toInput(f, this.view!.values[f.key]);
    let input: Input;
    if (f.type === "bool") input = h("input", { type: "checkbox", checked: v });
    else if (f.type === "lines" || f.type === "json") input = h("textarea", { value: v, rows: f.type === "json" ? 6 : 3, spellcheck: false, className: f.type });
    else if (f.type === "select") { input = h("select", {}, ...(f.options ?? []).map(o => h("option", { value: o, textContent: o || "(none)" }))); input.value = String(v); }
    else input = h("input", { type: f.type === "secret" ? "password" : f.type === "number" || f.type === "port" ? "number" : "text", value: v,
                              autocomplete: "off", spellcheck: false, ...(f.type === "port" ? { min: 0, max: 65535 } : {}),
                              ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}) });
    input.name = f.key;
    input.addEventListener("input", () => this.changed());
    input.addEventListener("change", () => this.changed());
    this.inputs.set(f.key, input);
    const help = f.help ? [h("div", { className: "sf-help", textContent: f.help })] : [];
    if (f.type === "bool") return h("div", { className: "sf-field" }, h("label", { className: "sf-check" }, input, f.label), ...help);
    const show = f.type === "secret" ? [h("button", { type: "button", className: "sf-show", textContent: "show",
                                                      onclick: (e: Event) => { const i = input as HTMLInputElement; i.type = i.type === "password" ? "text" : "password"; (e.target as HTMLButtonElement).textContent = i.type === "password" ? "show" : "hide"; } })] : [];
    return h("div", { className: "sf-field" }, h("label", { className: "sf-label", textContent: f.label, htmlFor: `sf-${f.key}` }),
             h("div", { className: "sf-input" }, Object.assign(input, { id: `sf-${f.key}` }), ...show), ...help);
  }

  /** after an edit: how many changes, or which input is not valid */
  private changed(): void {
    let n = 0, bad = "";
    try { n = Object.keys(this.patch()).length; } catch (e) { bad = e instanceof Error ? e.message : String(e); }
    this.saveBtn.disabled = !n || !!bad;
    this.discardBtn.disabled = !n && !bad;
    this.saveBtn.textContent = n > 1 ? `Save ${n} changes` : "Save";
    this.status.textContent = bad;
    this.status.className = bad ? "sf-status bad" : "sf-status";
  }

  private async save(): Promise<void> {
    let patch: Record<string, unknown>;
    try { patch = this.patch(); } catch { return; }
    this.saveBtn.disabled = true;
    this.status.textContent = "saving…";
    try {
      const saved = await this.calls.save(patch);
      this.view = saved;
      this.showError("");
      this.render();
      this.status.textContent = "saved";
      this.o.onSaved?.(saved, patch);
      if (saved.moved) this.follow(saved.moved);
    } catch (e) {
      this.status.textContent = "";
      this.showError(e instanceof Error ? e.message : String(e));
      this.changed();
    }
  }

  private follow(moved: { host: string; port: number }): void {
    const url = movedUrl(location, moved), where = `${moved.host}:${moved.port}`;
    if (this.o.follow === false) { this.status.textContent = `saved; the server now listens on ${where}`; return; }
    if (!url) { this.status.textContent = `saved; the server now listens on ${where}, which this browser cannot reach`; return; }
    this.status.textContent = `saved; opening ${url}…`;
    setTimeout(() => (this.o.navigate ?? (u => { location.href = u; }))(url), 800);
  }

  private showError(msg: string): void {
    this.error.textContent = msg;
    this.error.hidden = !msg;
  }
}
