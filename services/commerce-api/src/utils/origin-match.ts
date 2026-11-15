/**
 * Shared CORS / access-control origin matching.
 *
 * Allowlist entries are exact Origin strings, a bare `*` (allow any), or a
 * pattern with `*` in the hostname only (e.g. `https://*-team.vercel.app`).
 */

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Default port for a URL protocol, or empty when unknown. */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

/**
 * True when an allowlist entry uses a hostname wildcard (`*` somewhere in the
 * host). A bare `*` is the allow-any sentinel, not a hostname pattern.
 */
export function isWildcardOriginEntry(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed || trimmed === "*") return false;
  try {
    return new URL(trimmed).hostname.includes("*");
  } catch {
    return trimmed.includes("*");
  }
}

/** True when the entry is a concrete Origin suitable as a request Origin fallback. */
export function isConcreteOriginEntry(entry: string): boolean {
  const trimmed = entry.trim();
  return Boolean(trimmed) && trimmed !== "*" && !isWildcardOriginEntry(trimmed);
}

/** First concrete (non-`*`, non-wildcard) entry, if any. */
export function pickConcreteCorsOrigin(
  origins: readonly string[],
): string | undefined {
  return origins.find(isConcreteOriginEntry);
}

/**
 * Match a request Origin against one allowlist entry.
 *
 * - Exact entries: string equality with the Origin.
 * - Bare `*`: always matches.
 * - Hostname wildcards: scheme must match exactly, ports must match, and each
 *   `*` in the hostname matches one or more `[a-z0-9-]` characters only
 *   (case-insensitive, anchored). Literals are regex-escaped before compile.
 */
export function originMatchesEntry(origin: string, entry: string): boolean {
  const pattern = entry.trim();
  if (!pattern) return false;
  if (pattern === "*") return true;

  if (!pattern.includes("*")) {
    return pattern === origin;
  }

  let originUrl: URL;
  let patternUrl: URL;
  try {
    originUrl = new URL(origin);
    patternUrl = new URL(pattern);
  } catch {
    return false;
  }

  if (!patternUrl.hostname.includes("*")) {
    // `*` only elsewhere (e.g. path) — treat as non-matching pattern.
    return false;
  }

  if (originUrl.protocol !== patternUrl.protocol) return false;
  if (effectivePort(originUrl) !== effectivePort(patternUrl)) return false;

  const parts = patternUrl.hostname.toLowerCase().split("*");
  const regexBody = parts.map(escapeRegExp).join("[a-z0-9-]+");
  const hostRe = new RegExp(`^${regexBody}$`, "i");
  return hostRe.test(originUrl.hostname);
}

/** True when the Origin matches any allowlist entry. */
export function originMatchesAny(
  origin: string,
  entries: readonly string[],
): boolean {
  return entries.some((entry) => originMatchesEntry(origin, entry));
}
