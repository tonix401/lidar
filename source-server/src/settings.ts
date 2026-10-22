// Changing the source server's settings while it runs (PUT /api/settings): checked against the fields (store.ts),
// applied at once (another address or port rebinds, another recordings folder is used from now on), then saved.
// Whatever can be refused is tried before anything changes, so a refused change changes nothing.
import { resolve } from "node:path";
import { ValueError } from "@mrs6000/server-common/errors";
import type { Listen } from "@mrs6000/server-common/listener";
import { changedKeys, checkPatch, setPath, settingsView } from "@mrs6000/server-common/settings";
import type { SettingsSaved } from "@mrs6000/wire/settings";
import type { Hub } from "./hub";
import { FIELDS, type Store } from "./store";

export interface Movable { at: Listen; move(to: Listen): void }

/** a relative recordings folder is in the repository */
export const recordingsDir = (repo: string, folder: string): string => resolve(repo, folder);

export function applySettings(hub: Hub, store: Store, listener: Movable | null, repo: string, body: Record<string, unknown>): SettingsSaved {
  const patch = checkPatch(FIELDS, body), changed = new Set(changedKeys(patch, store.data));
  if (changed.has("host") && !patch.host) throw new ValueError("Address: e.g. 127.0.0.1 or 0.0.0.0");
  if (changed.has("recordings") && !patch.recordings) throw new ValueError("Recordings folder: a folder");
  if (changed.has("recordings") && hub.recorder.active) throw new ValueError("stop the recording first");
  let moved: Listen | undefined;
  if (listener && (changed.has("host") || changed.has("port"))) {
    listener.move({ host: (patch.host as string | undefined) ?? store.data.host, port: (patch.port as number | undefined) ?? store.data.port });
    moved = { ...listener.at };
  }
  if (changed.has("recordings")) hub.setRecDir(recordingsDir(repo, patch.recordings as string));
  for (const k of changed) setPath(store.data, k, patch[k]);
  store.save();
  return { ...settingsView(FIELDS, store.data), ...(moved ? { moved } : {}) };
}
