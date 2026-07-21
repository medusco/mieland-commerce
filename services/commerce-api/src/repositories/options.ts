import { queryOne, t } from "../db/mysql.js";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";

export type WpOptionMap = Record<string, unknown>;

function maybeUnserializePhp(raw: string): unknown {
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
      const val = s.slice(i, i + len);
      i += len;
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

export async function getOptionRaw(name: string): Promise<string | null> {
  const cfg = loadConfig();
  const cacheKey = `opt:${cfg.tablePrefix}:${name}`;
  const redis = getRedis();
  const cached = await redis.get(cacheKey);
  if (cached !== null) return cached === "__null__" ? null : cached;

  const row = await queryOne<{ option_value: string }>(
    `SELECT option_value FROM ${t("options")} WHERE option_name = ? LIMIT 1`,
    [name],
  );
  const value = row?.option_value ?? null;
  await redis.set(
    cacheKey,
    value ?? "__null__",
    "EX",
    cfg.CATALOG_CACHE_TTL_SECONDS,
  );
  return value;
}

export async function getOption<T = unknown>(name: string): Promise<T | null> {
  const raw = await getOptionRaw(name);
  if (raw == null) return null;
  return maybeUnserializePhp(raw) as T;
}

export async function getOptionString(
  name: string,
  fallback = "",
): Promise<string> {
  const raw = await getOptionRaw(name);
  return raw ?? fallback;
}
