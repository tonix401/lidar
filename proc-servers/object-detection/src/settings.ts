// Changing an object-detection server's settings while it runs (PUT /api/settings): checked against the fields
// (store.ts), applied at once (another address or port rebinds; another source, token or name ends the replays and
// starts the live processing afresh; processing settings reach the live processing and the replays), then saved.
// What can be refused is tried first, so a refused change changes nothing.
import { resolve } from "node:path";
import { defaultConfig, mergeConfig } from "@mrs6000/processing/config/config";
import { ValueError } from "@mrs6000/server-common/errors";
import type { Listen } from "@mrs6000/server-common/listener";
import { changedKeys, checkPatch, setPath, settingsView } from "@mrs6000/server-common/settings";
import type { SettingsSaved } from "@mrs6000/wire/settings";
import type { Hub } from "./hub";
import { FIELDS, type ServerConfig, type Store } from "./store";

export interface Movable { at: Listen; move(to: Listen): void }

const RECONNECT = ["source.url", "source.token", "name"];

/** this server's folder of the track cache: its name inside the cache folder (relative: in the repository) */
export const cacheRoot = (repo: string, d: Pick<ServerConfig, "cache" | "name">): string => resolve(repo, d.cache, d.name);

export const sourceAddress = (d: ServerConfig) => ({ url: d.source.url, token: d.source.token || undefined, name: d.name });

export function applySettings(hub: Hub, store: Store, listener: Movable | null, repo: string, body: Record<string, unknown>): SettingsSaved {
  const patch = checkPatch(FIELDS, body), changed = new Set(changedKeys(patch, store.data));
  if (changed.has("host") && !patch.host) throw new ValueError("Address: e.g. 127.0.0.1 or 0.0.0.0");
  if (changed.has("name") && !/^[A-Za-z0-9_-]{1,64}$/.test(String(patch.name))) throw new ValueError("Name: letters, digits, _ and -, at most 64");
  if (changed.has("cache") && !patch.cache) throw new ValueError("Track cache folder: a folder");
  let moved: Listen | undefined;
  if (listener && (changed.has("host") || changed.has("port"))) {
    listener.move({ host: (patch.host as string | undefined) ?? store.data.host, port: (patch.port as number | undefined) ?? store.data.port });
    moved = { ...listener.at };
  }
  for (const k of changed) setPath(store.data, k, patch[k]);
  const d = store.data;
  if (changed.has("processing")) hub.setConfig(mergeConfig(defaultConfig(), d.processing));
  if (changed.has("maxSessions")) hub.maxProcessing = d.maxSessions;
  if (RECONNECT.some(k => changed.has(k))) hub.reconnect(d.name, sourceAddress(d), cacheRoot(repo, d));
  else if (changed.has("cache")) hub.cacheRoot = cacheRoot(repo, d);
  store.save();
  return { ...settingsView(FIELDS, d), ...(moved ? { moved } : {}) };
}
