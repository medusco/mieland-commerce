import { unserializeAcf } from "./acf.js";

export type NavigationLink = { title: string | null; url: string; target: string | null };

/** Normalize an ACF link field value (serialized PHP array, JSON, or object) to {title,url,target}, or null. */
export function parseNavigationLink(value: unknown): NavigationLink | null {
  let v = value;
  if (typeof v === "string") {
    const raw = v.trim();
    if (!raw) return null;
    try {
      v = unserializeAcf(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  if (!url) return null;
  const str = (x: unknown) => (typeof x === "string" && x !== "" ? x : null);
  return { title: str(o.title), url, target: str(o.target) };
}

/** ACF group that WPGraphQL exposes as `mielandNavigationLegalLinks`; sub-fields are stored as options_<group>_<field>. */
const LEGAL_LINKS_GROUP = "mieland_navigation_legal_links";

function firstLink(optionMeta: Record<string, unknown>, field: string): NavigationLink | null {
  return (
    parseNavigationLink(optionMeta[field]) ??
    parseNavigationLink(optionMeta[`${LEGAL_LINKS_GROUP}_${field}`])
  );
}

/** Reads ACF options `terms_of_service` / `privacy_policy` (stored as options_<name>) from de-prefixed option meta. */
export function navigationLegalLinks(optionMeta: Record<string, unknown>) {
  return {
    termsOfService: firstLink(optionMeta, "terms_of_service"),
    privacyPolicy: firstLink(optionMeta, "privacy_policy"),
  };
}
