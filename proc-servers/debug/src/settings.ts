// Changing the debug server's settings while it runs (PUT /api/settings): checked against the fields (store.ts),
// applied at once (another address or port rebinds; another source, name, token or the own objects on or off start
// every view afresh; another start replay is opened), then saved. What can be refused is tried first; only a start
// replay that fails after the views started afresh leaves the other changes in place (and says so).
import { defaultConfig, mergeConfig } from "@mrs6000/processing/config/config";
import { describeError, ValueError } from "@mrs6000/server-common/errors";
import type { Listen } from "@mrs6000/server-common/listener";
import { changedKeys, checkPatch, setPath, settingsView } from "@mrs6000/server-common/settings";
import type { SettingsSaved } from "@mrs6000/wire/settings";
import type { Hub } from "./hub";
import { FIELDS, type Store } from "./store";

export interface Movable { at: Listen; move(to: Listen): void }

const RECONNECT = ["source.url", "source.token", "name", "objects"];

export async function applySettings(hub: Hub, store: Store, listener: Movable | null, body: Record<string, unknown>): Promise<SettingsSaved> {
  const patch = checkPatch(FIELDS, body), changed = new Set(changedKeys(patch, store.data));
  if (changed.has("host") && !patch.host) throw new ValueError("Address: e.g. 127.0.0.1 or 0.0.0.0");
  if (changed.has("name") && !patch.name) throw new ValueError("Name: a name");
  const reconnect = RECONNECT.some(k => changed.has(k));
  const replay = changed.has("replay") || (reconnect && store.data.replay) ? ((patch.replay ?? store.data.replay) as string) : null;
  if (replay !== null && !reconnect) await hub.setDefaultReplay(replay);     // refused: nothing changed yet
  let moved: Listen | undefined;
  if (listener && (changed.has("host") || changed.has("port"))) {
    listener.move({ host: (patch.host as string | undefined) ?? store.data.host, port: (patch.port as number | undefined) ?? store.data.port });
    moved = { ...listener.at };
  }
  for (const k of changed) setPath(store.data, k, patch[k]);
  if (changed.has("processing")) hub.setConfig(mergeConfig(defaultConfig(), store.data.processing));
  let failed = "";
  if (reconnect) {
    hub.reconnect({ url: store.data.source.url, token: store.data.source.token || undefined, name: store.data.name }, store.data.objects);
    if (replay) await hub.setDefaultReplay(replay).catch(e => { failed = describeError(e); store.data.replay = ""; });
  }
  store.save();
  if (failed) throw new ValueError(`the other settings are saved, but the replay cannot start: ${failed}`);
  return { ...settingsView(FIELDS, store.data), ...(moved ? { moved } : {}) };
}
