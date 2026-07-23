import { createHash, randomBytes } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function requestId(): string {
  return randomBytes(8).toString("hex");
}

export function redactPii(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.includes("@") && value.includes(".")) return "[redacted-email]";
    if (value.length > 40 && /^[A-Za-z0-9._\-]+$/.test(value)) {
      return "[redacted-token]";
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactPii);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (
        key.includes("password") ||
        key.includes("secret") ||
        key.includes("token") ||
        key.includes("authorization") ||
        key.includes("cookie")
      ) {
        out[k] = "[redacted]";
      } else if (key.includes("email")) {
        out[k] = "[redacted-email]";
      } else {
        out[k] = redactPii(v);
      }
    }
    return out;
  }
  return value;
}

export function logJson(
  level: "info" | "warn" | "error",
  fields: Record<string, unknown>,
): void {
  const redacted = redactPii(fields);
  const safe =
    redacted && typeof redacted === "object"
      ? (redacted as Record<string, unknown>)
      : { value: redacted };
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...safe,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** WooCommerce money rounding (2 decimals by default). */
export function roundMoney(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function moneyStr(n: number, decimals = 2): string {
  return roundMoney(n, decimals).toFixed(decimals);
}

export function parseSessionHeader(
  header: string | undefined | null,
): string | null {
  if (!header) return null;
  const m = header.match(/^\s*Session\s+(\S+)\s*$/i);
  return m?.[1] ?? null;
}

export function toGlobalId(type: string, id: number | string): string {
  return Buffer.from(`${type}:${id}`).toString("base64url");
}

export function fromGlobalId(
  id: string,
): { type: string; id: string } | null {
  try {
    const raw = Buffer.from(id, "base64url").toString("utf8");
    const idx = raw.indexOf(":");
    if (idx < 0) return null;
    return { type: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

export function parseDatabaseId(id: string | number): number {
  if (typeof id === "number") return id;
  if (/^\d+$/.test(id)) return Number(id);
  const g = fromGlobalId(id);
  if (g && /^\d+$/.test(g.id)) return Number(g.id);
  return Number(id) || 0;
}
