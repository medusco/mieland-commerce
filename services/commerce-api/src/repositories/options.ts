import { query, t } from "../db/mysql.js";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";
import { memoryGet, memorySet } from "../utils/memory-cache.js";

export type WpOptionMap = Record<string, unknown>;

const OPTION_NULL = "__null__";

function utf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** PHP `s:N:"..."` uses UTF-8 byte length, not JS string length. */
function readPhpUtf8String(
  s: string,
  start: number,
  byteLen: number,
): { value: string; end: number } {
  let end = start;
  let bytes = 0;
  while (end < s.length) {
    const codePoint = s.codePointAt(end)!;
    const charBytes = utf8ByteLength(codePoint);
    if (bytes + charBytes > byteLen) break;
    bytes += charBytes;
    end += codePoint > 0xffff ? 2 : 1;
  }
  if (bytes !== byteLen) throw new Error("bad string close");
  return { value: s.slice(start, end), end };
}

export function maybeUnserializePhp(raw: string): unknown {
  // WordSQL options are often PHP-serialized. Handle common shapes without a full unserializer.
  if (!raw) return raw;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      /* fall through */
    }
  }
  // a:N:{...} or s:N:"..." — use lightweight parse for arrays of scalars + nested
  if (raw.startsWith("a:") || raw.startsWith("O:") || raw.startsWith("s:")) {
    try {
      return phpUnserialize(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Minimal PHP serialize parser for option arrays used by headless-login / WC. */
export function phpUnserialize(input: string): unknown {
  let i = 0;
  const s = input;

  function readUntil(ch: string): string {
    const start = i;
    while (i < s.length && s[i] !== ch) i++;
    const out = s.slice(start, i);
    if (s[i] === ch) i++;
    return out;
  }

  function parseValue(): unknown {
    const type = s[i++];
    if (type === "N") {
      if (s[i++] !== ";") throw new Error("bad null");
      return null;
    }
    if (type === "b") {
      if (s[i++] !== ":") throw new Error("bad bool");
      const v = readUntil(";");
      return v === "1";
    }
    if (type === "i") {
      if (s[i++] !== ":") throw new Error("bad int");
      return Number(readUntil(";"));
    }
    if (type === "d") {
      if (s[i++] !== ":") throw new Error("bad double");
      return Number(readUntil(";"));
    }
    if (type === "s") {
      if (s[i++] !== ":") throw new Error("bad string len");
      const len = Number(readUntil(":"));
      if (s[i++] !== '"') throw new Error("bad string open");
      const { value: val, end } = readPhpUtf8String(s, i, len);
      i = end;
      if (s[i++] !== '"') throw new Error("bad string close");
      if (s[i++] !== ";") throw new Error("bad string end");
      return val;
    }
    if (type === "a") {
      if (s[i++] !== ":") throw new Error("bad array");
      const len = Number(readUntil(":"));
      if (s[i++] !== "{") throw new Error("bad array open");
      const obj: Record<string | number, unknown> = {};
      let allInt = true;
      const arr: unknown[] = [];
      for (let n = 0; n < len; n++) {
        const key = parseValue();
        const val = parseValue();
        if (typeof key === "number" && key === n && allInt) {
          arr.push(val);
        } else {
          allInt = false;
        }
        obj[key as string | number] = val;
      }
      if (s[i++] !== "}") throw new Error("bad array close");
      if (allInt && arr.length === len) return arr;
      return obj;
    }
    // skip unsupported object
    throw new Error(`unsupported type ${type}`);
  }

  return parseValue();
}

function optionCacheKey(tablePrefix: string, name: string): string {
  return `opt:${tablePrefix}:${name}`;
}

/**
 * Batch-load raw option values (memory → Redis MGET → one IN query for misses).
 * Exported for unit tests with injectable I/O.
 */
export async function loadOptionValuesRaw(
  names: string[],
  io: {
    tablePrefix: string;
    ttlSeconds: number;
    memoryGet: (key: string) => string | undefined;
    memorySet: (key: string, value: string) => void;
    redisMget: (keys: string[]) => Promise<(string | null)[]>;
    redisSetMany: (
      entries: Array<{ key: string; value: string; ttl: number }>,
    ) => Promise<void>;
    queryByNames: (
      names: string[],
    ) => Promise<Array<{ option_name: string; option_value: string }>>;
  },
): Promise<Map<string, string | null>> {
  const unique = [...new Set(names.filter((name) => name.length > 0))];
  const out = new Map<string, string | null>();
  if (!unique.length) return out;

  const redisMisses: string[] = [];
  for (const name of unique) {
    const cacheKey = optionCacheKey(io.tablePrefix, name);
    const mem = io.memoryGet(cacheKey);
    if (mem !== undefined) {
      out.set(name, mem === OPTION_NULL ? null : mem);
    } else {
      redisMisses.push(name);
    }
  }

  if (!redisMisses.length) return out;

  const redisKeys = redisMisses.map((name) =>
    optionCacheKey(io.tablePrefix, name),
  );
  const cached = await io.redisMget(redisKeys);
  const dbMisses: string[] = [];
  for (let i = 0; i < redisMisses.length; i++) {
    const name = redisMisses[i]!;
    const raw = cached[i] ?? null;
    const cacheKey = redisKeys[i]!;
    if (raw !== null) {
      io.memorySet(cacheKey, raw);
      out.set(name, raw === OPTION_NULL ? null : raw);
    } else {
      dbMisses.push(name);
    }
  }

  if (!dbMisses.length) return out;

  const rows = await io.queryByNames(dbMisses);
  const found = new Map<string, string | null>();
  for (const row of rows) {
    found.set(row.option_name, row.option_value ?? null);
  }

  const toCache: Array<{ key: string; value: string; ttl: number }> = [];
  for (const name of dbMisses) {
    const value = found.has(name) ? (found.get(name) ?? null) : null;
    const stored = value ?? OPTION_NULL;
    const cacheKey = optionCacheKey(io.tablePrefix, name);
    toCache.push({ key: cacheKey, value: stored, ttl: io.ttlSeconds });
    io.memorySet(cacheKey, stored);
    out.set(name, value);
  }
  await io.redisSetMany(toCache);
  return out;
}

export async function getOptionRaw(name: string): Promise<string | null> {
  const map = await getOptionsRaw([name]);
  return map.get(name) ?? null;
}

/** Batch-load raw option strings with the same cache semantics as getOptionRaw. */
export async function getOptionsRaw(
  names: string[],
): Promise<Map<string, string | null>> {
  const cfg = loadConfig();
  const redis = getRedis();
  return loadOptionValuesRaw(names, {
    tablePrefix: cfg.tablePrefix,
    ttlSeconds: cfg.CATALOG_CACHE_TTL_SECONDS,
    memoryGet,
    memorySet,
    redisMget: (keys) =>
      keys.length ? redis.mget(...keys) : Promise.resolve([]),
    redisSetMany: async (entries) => {
      if (!entries.length) return;
      const pipeline = redis.pipeline();
      for (const entry of entries) {
        pipeline.set(entry.key, entry.value, "EX", entry.ttl);
      }
      await pipeline.exec();
    },
    queryByNames: async (misses) => {
      if (!misses.length) return [];
      const placeholders = misses.map(() => "?").join(",");
      return query<{ option_name: string; option_value: string }[]>(
        `SELECT option_name, option_value FROM ${t("options")} WHERE option_name IN (${placeholders})`,
        misses,
      );
    },
  });
}

export async function getOption<T = unknown>(name: string): Promise<T | null> {
  const raw = await getOptionRaw(name);
  if (raw == null) return null;
  return maybeUnserializePhp(raw) as T;
}

/** Batch-load and unserialize options (one Redis MGET + one IN query for misses). */
export async function getOptions<T = unknown>(
  names: string[],
): Promise<Map<string, T | null>> {
  const raw = await getOptionsRaw(names);
  const out = new Map<string, T | null>();
  for (const [name, value] of raw) {
    out.set(name, value == null ? null : (maybeUnserializePhp(value) as T));
  }
  return out;
}

export async function getOptionsByPrefix(
  prefix: string,
): Promise<Record<string, string>> {
  const rows = await query<{ option_name: string; option_value: string }[]>(
    `SELECT option_name, option_value FROM ${t("options")}
     WHERE option_name LIKE ?`,
    [`${prefix}%`],
  );
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.option_name] = row.option_value ?? "";
  }
  return out;
}

export async function getOptionString(
  name: string,
  fallback = "",
): Promise<string> {
  const raw = await getOptionRaw(name);
  return raw ?? fallback;
}
