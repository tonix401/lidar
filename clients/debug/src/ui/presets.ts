// The user's named filter settings, kept in the browser: a preset is what ConfigState.toJSON() gives (the mode and
// every stage's settings). No DOM.
import type { ConfigState } from "@mrs6000/processing/config/state";
import { KEYS, type Store } from "./storage";

export const MAX_NAME = 40;
const BUILT_IN = ["off", "light", "medium", "strong", "custom"];

export type Saved = ReturnType<ConfigState["toJSON"]>;

export class UserPresets {
  constructor(private store: Store) {}

  /** saved names, sorted */
  names(): string[] { return Object.keys(this.all()).sort((a, b) => a.localeCompare(b)); }

  /** what is stored under `name` (null: nothing) */
  get(name: string): Saved | null { return this.all()[name] ?? null; }

  /** why `name` cannot be used, or "" */
  check(name: string): string {
    const n = name.trim();
    if (!n) return "give the preset a name";
    if (n.length > MAX_NAME) return `a name is at most ${MAX_NAME} characters`;
    if (BUILT_IN.includes(n.toLowerCase())) return `"${n}" is one of the built-in presets`;
    return "";
  }

  /** save the settings in effect under `name` (replacing one of that name); the stored name, or throws why not */
  save(name: string, state: ConfigState): string {
    const why = this.check(name), n = name.trim();
    if (why) throw new Error(why);
    this.store.setJson(KEYS.presets, { ...this.all(), [n]: structuredClone(state.toJSON()) });
    return n;
  }

  remove(name: string): void {
    const all = this.all();
    delete all[name];
    this.store.setJson(KEYS.presets, all);
  }

  private all(): Record<string, Saved> {
    const v = this.store.json<unknown>(KEYS.presets);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, p]) => p && typeof p === "object")) as Record<string, Saved>;
  }
}
