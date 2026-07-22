import { loadConfig } from "../config.js";
import { getOptionString } from "./options.js";

let cachedBase: { value: string; expiresAt: number } | null = null;

/**
 * Uploads CDN / base URL (matches WP S3 Uploads `S3_UPLOADS_BUCKET_URL`
 * or `upload_url_path`, else `{siteurl}/wp-content/uploads`).
 */
export async function getMediaBaseUrl(): Promise<string> {
  const now = Date.now();
  if (cachedBase && cachedBase.expiresAt > now) return cachedBase.value;

  const cfg = loadConfig();
  let base = stripTrailingSlash(cfg.MEDIA_BASE_URL);
  if (!base) {
    const uploadUrlPath = stripTrailingSlash(
      (await getOptionString("upload_url_path")).trim(),
    );
    if (uploadUrlPath) {
      base = uploadUrlPath;
    } else {
      const siteurl = stripTrailingSlash(
        await getOptionString("siteurl", cfg.WORDPRESS_URL),
      );
      base = `${siteurl}/wp-content/uploads`;
    }
  }

  cachedBase = {
    value: base,
    expiresAt: now + cfg.CATALOG_CACHE_TTL_SECONDS * 1000,
  };
  return base;
}

/** Rebuild a public media URL the way WP + S3 Uploads would. */
export function buildMediaItemUrl(
  attachedFile: string | undefined | null,
  guid: string,
  mediaBaseUrl: string,
): string {
  const file = (attachedFile ?? "").trim();
  if (file) {
    if (/^https?:\/\//i.test(file)) {
      return applyMediaBaseToAbsoluteUrl(file, mediaBaseUrl);
    }
    if (file.startsWith("//")) {
      return applyMediaBaseToAbsoluteUrl(`https:${file}`, mediaBaseUrl);
    }
    return joinBase(mediaBaseUrl, file.replace(/^\/+/, ""));
  }
  if (guid) return applyMediaBaseToAbsoluteUrl(guid, mediaBaseUrl);
  return "";
}

function applyMediaBaseToAbsoluteUrl(
  url: string,
  mediaBaseUrl: string,
): string {
  if (!mediaBaseUrl) return url;
  try {
    const parsed = new URL(url);
    const base = new URL(ensureTrailingSlash(mediaBaseUrl));
    if (parsed.host === base.host) return url;

    const marker = "/wp-content/uploads/";
    const idx = parsed.pathname.indexOf(marker);
    if (idx >= 0) {
      return joinBase(
        mediaBaseUrl,
        parsed.pathname.slice(idx + marker.length) + parsed.search,
      );
    }

    return joinBase(
      mediaBaseUrl,
      parsed.pathname.replace(/^\/+/, "") + parsed.search,
    );
  } catch {
    return url;
  }
}

function joinBase(base: string, path: string): string {
  return `${stripTrailingSlash(base)}/${path.replace(/^\/+/, "")}`;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function ensureTrailingSlash(s: string): string {
  return s.endsWith("/") ? s : `${s}/`;
}
