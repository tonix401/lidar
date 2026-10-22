// The Server section: the debug server's own settings (its source server, where it listens, its own objects, the
// replay every page opens first, access), with the admin token they need once the server has one. Loaded when the
// section is opened.
import { SettingsForm } from "@mrs6000/web/settingsForm";
import "@mrs6000/web/settingsForm.css";
import type { Api } from "../api/client";
import { $ } from "./dom";
import { KEYS, type Store } from "./storage";

export class ServerPanel {
  readonly form: SettingsForm;

  /** `follow`: open the server's new address after it moved (not from the Vite dev page) */
  constructor(api: Api, store: Store, follow: boolean) {
    const token = $<HTMLInputElement>("adminToken"), section = $<HTMLDetailsElement>("secServer");
    token.value = store.get(KEYS.adminToken) ?? "";
    this.form = new SettingsForm({ load: () => api.settings(token.value.trim()), save: p => api.saveSettings(p, token.value.trim()) }, {
      follow,
      onSaved: (_, patch) => {                 // a new admin token: this page uses it from now on
        if (typeof patch.adminToken === "string") { token.value = patch.adminToken; store.set(KEYS.adminToken, patch.adminToken); }
      },
    });
    $("serverSettings").append(this.form.el);
    token.onchange = () => { store.set(KEYS.adminToken, token.value.trim()); void this.form.load(); };
    section.addEventListener("toggle", () => { if (section.open) void this.form.load(); });
    if (section.open) void this.form.load();
  }
}
