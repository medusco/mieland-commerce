import { loadConfig } from "../config.js";

type Entry = { value: string; expiresAt: number };

const store = new Map<string, Entry>();

function ttlMs(): number {
  return loadConfig().MEMORY_CACHE_TTL_SECONDS * 1000;
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

/** `undefined` = miss; string = hit (may be empty). */
export function memoryGet(key: string): string | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function memorySet(key: string, value: string): void {
  if (store.size > 10_000) pruneExpired();
  store.set(key, { value, expiresAt: Date.now() + ttlMs() });
}
