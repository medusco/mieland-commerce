import { loadConfig } from "../config.js";

export type WpCookiePolicy = {
  sameSite: "lax" | "none";
  secure: boolean;
  partitioned: boolean;
  domain?: string;
};

/** True when the client hit commerce over HTTPS (incl. Railway / proxies). */
export function isSecureRequest(req: Request): boolean {
  if (req.url.startsWith("https://")) return true;
  const proto = (
    req.headers.get("x-forwarded-proto") ||
    req.headers.get("X-Forwarded-Proto") ||
    ""
  )
    .split(",")[0]
    ?.trim()
    .toLowerCase();
  return proto === "https";
}

/** True when Origin host differs from the request Host (cross-origin). */
export function isCrossOriginRequest(req: Request): boolean {
  const origin = req.headers.get("origin") || req.headers.get("Origin");
  if (!origin) return false;
  try {
    const originHost = new URL(origin).host;
    const reqUrl = new URL(req.url);
    return Boolean(originHost) && originHost !== reqUrl.host;
  } catch {
    return false;
  }
}

/** @deprecated Use {@link isCrossOriginRequest}. */
export const isCrossSiteRequest = isCrossOriginRequest;

function registrableDomain(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

/**
 * Cross-origin but same registrable domain (e.g. www.mielandmanuka.com → shop.mielandmanuka.com).
 * Browsers treat these as same-site; Lax cookies work without Partitioned/None.
 */
export function isSameRegistrableDomainCrossOrigin(req: Request): boolean {
  const origin = req.headers.get("origin") || req.headers.get("Origin");
  if (!origin) return false;
  try {
    const originHost = new URL(origin).hostname;
    const reqHost = new URL(req.url).hostname;
    if (!originHost || originHost === reqHost) return false;
    return registrableDomain(originHost) === registrableDomain(reqHost);
  } catch {
    return false;
  }
}

function resolveCookieDomain(req: Request): string | undefined {
  const configured = loadConfig().authCookieDomain?.trim();
  if (configured) return configured;

  if (!isSameRegistrableDomainCrossOrigin(req)) return undefined;

  const reqHost = new URL(req.url).hostname;
  const root = registrableDomain(reqHost);
  return root ? `.${root}` : undefined;
}

/**
 * Cookie attributes for mc-wp-session / mc-wp-refresh.
 *
 * - Sibling subdomains (www → shop): SameSite=Lax + Domain=.example.com (no Partitioned)
 * - Truly cross-site storefront: SameSite=None; Secure; Partitioned
 * - Local same-origin HTTP: SameSite=Lax
 */
export function resolveWpCookiePolicy(req: Request): WpCookiePolicy {
  const secure = isSecureRequest(req);

  if (isSameRegistrableDomainCrossOrigin(req)) {
    return {
      sameSite: "lax",
      secure,
      partitioned: false,
      domain: resolveCookieDomain(req),
    };
  }

  if (isCrossOriginRequest(req) && secure) {
    return {
      sameSite: "none",
      secure: true,
      partitioned: true,
      domain: resolveCookieDomain(req),
    };
  }

  return {
    sameSite: "lax",
    secure: false,
    partitioned: false,
  };
}
