import { phpUnserialize } from "./options.js";
import { getAttachmentUrl } from "./products.js";

const PRODUCT_ID_FIELD =
  /(?:^|_)(products?_?ids|bestsellerproductids)(?:_|$)/i;

const IMAGE_FIELD =
  /(^|_)(image|icon|svg_icon|svg_image|video_url|pdf_file|background_image|hero_image|logo_image|badge_image|badge_icon|product_image|main_image)s?$/i;

function isProductIdField(field: string): boolean {
  const normalized = field.replace(/-/g, "_");
  return PRODUCT_ID_FIELD.test(normalized);
}

export function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function toPascal(key: string): string {
  const camel = snakeToCamel(key.replace(/[^a-zA-Z0-9_]/g, "_"));
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function looksSerialized(raw: string): boolean {
  return (
    raw.startsWith("a:") ||
    raw.startsWith("O:") ||
    raw.startsWith("s:") ||
    raw.startsWith("{") ||
    raw.startsWith("[")
  );
}

export function unserializeAcf(raw: string): unknown {
  if (!raw) return raw;
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (raw.startsWith("a:") || raw.startsWith("O:") || raw.startsWith("s:")) {
    try {
      return phpUnserialize(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function asLink(value: unknown): { title: string; url: string; target: string } | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const title = String(o.title ?? "");
  const url = String(o.url ?? "");
  const target = String(o.target ?? "");
  if (!title && !url) return null;
  return { title, url, target };
}

function asIdList(value: unknown): number[] {
  if (value == null || value === "" || value === "0") return [];
  if (typeof value === "number" && value > 0) return [value];
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return n > 0 ? [n] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => asIdList(item));
  }
  if (typeof value === "object" && value && "ID" in value) {
    return asIdList((value as { ID: unknown }).ID);
  }
  return [];
}

export function relationshipConnection(value: unknown): {
  nodes: Array<{ databaseId: number }>;
} {
  return { nodes: asIdList(value).map((databaseId) => ({ databaseId })) };
}

async function mediaEdge(id: number) {
  const media = await getAttachmentUrl(id);
  if (!media) return null;
  return {
    node: {
      sourceUrl: media.sourceUrl,
      mediaItemUrl: media.mediaItemUrl,
      altText: media.altText,
    },
  };
}

function hasIndexedChildren(meta: Record<string, string>, field: string): boolean {
  const prefix = `${field}_0_`;
  return Object.keys(meta).some((k) => k.startsWith(prefix));
}

function hasGroupChildren(meta: Record<string, string>, field: string): boolean {
  const prefix = `${field}_`;
  return Object.keys(meta).some(
    (k) => k.startsWith(prefix) && !k.slice(prefix.length).match(/^\d+_/),
  );
}

function firstFieldName(rest: string): string {
  if (rest === "acf_fc_layout") return rest;
  // field names can contain underscores; detect next `_N_` as repeater index
  const idx = rest.search(/_\d+_/);
  if (idx > 0) return rest.slice(0, idx);
  const endIdx = rest.search(/_\d+$/);
  if (endIdx > 0 && /^\d+$/.test(rest.slice(endIdx + 1))) return rest.slice(0, endIdx);
  return rest;
}

function collectIndexedChildNames(meta: Record<string, string>, itemPrefix: string): string[] {
  const names = new Set<string>();
  const p = `${itemPrefix}_`;
  for (const key of Object.keys(meta)) {
    if (!key.startsWith(p)) continue;
    const rest = key.slice(p.length);
    if (rest === "acf_fc_layout") continue;
    names.add(firstFieldName(rest));
  }
  return [...names];
}

/** ACF flexible content stores layout names in the parent field value as index → layout slug. */
function flexLayoutMap(raw: string | undefined): Map<number, string> | null {
  if (!raw || !looksSerialized(raw)) return null;
  const parsed = unserializeAcf(raw);
  if (!parsed || typeof parsed !== "object") return null;

  const entries = Array.isArray(parsed)
    ? parsed.map((value, index) => [String(index), value] as const)
    : Object.entries(parsed as Record<string, unknown>);

  const map = new Map<number, string>();
  for (const [key, value] of entries) {
    const index = Number(key);
    if (!Number.isFinite(index) || typeof value !== "string" || !value.trim()) continue;
    map.set(index, value.trim());
  }
  return map.size ? map : null;
}

export async function shapeAcfField(
  meta: Record<string, string>,
  field: string,
  opts: { flexTypePrefix?: string } = {},
): Promise<unknown> {
  const raw = meta[field];
  const isList = hasIndexedChildren(meta, field);

  if (isList) {
    const layoutMap = flexLayoutMap(raw);
    const count = layoutMap
      ? Math.max(...layoutMap.keys()) + 1
      : Math.max(
          Number(raw) || 0,
          ...Object.keys(meta)
            .filter((k) => k.startsWith(`${field}_`) && /_\d+/.test(k))
            .map((k) => {
              const m = k.slice(field.length + 1).match(/^(\d+)/);
              return m ? Number(m[1]) + 1 : 0;
            }),
        );
    const items: unknown[] = [];
    for (let i = 0; i < count; i++) {
      const itemPrefix = `${field}_${i}`;
      const layout = meta[`${itemPrefix}_acf_fc_layout`] ?? layoutMap?.get(i);
      const childNames = collectIndexedChildNames(meta, itemPrefix);
      const obj: Record<string, unknown> = {};
      if (layout) {
        obj.fieldGroupName = `${opts.flexTypePrefix}${toPascal(layout)}Layout`;
        if (opts.flexTypePrefix) {
          obj.__typename = obj.fieldGroupName;
        }
      }
      for (const child of childNames) {
        obj[snakeToCamel(child)] = await shapeAcfField(meta, `${itemPrefix}_${child}`);
      }
      items.push(obj);
    }
    return items;
  }

  if (hasGroupChildren(meta, field) && !/^\d+$/.test(String(raw ?? ""))) {
    const childNames = collectIndexedChildNames(meta, field);
    const obj: Record<string, unknown> = {};
    for (const child of childNames) {
      obj[snakeToCamel(child)] = await shapeAcfField(meta, `${field}_${child}`, opts);
    }
    return obj;
  }

  if (raw == null || raw === "") return null;

  if (looksSerialized(raw)) {
    const parsed = unserializeAcf(raw);
    const link = asLink(parsed);
    if (link) return link;
    const ids = asIdList(parsed);
    if (ids.length && (IMAGE_FIELD.test(field) || field === "ico")) {
      if (ids.length === 1) {
        if (field === "ico") {
          const edge = await mediaEdge(ids[0]!);
          return edge?.node?.sourceUrl ?? edge?.node?.mediaItemUrl ?? raw;
        }
        return mediaEdge(ids[0]!);
      }
      const nodes = [];
      for (const id of ids) {
        const edge = await mediaEdge(id);
        if (edge?.node) nodes.push(edge.node);
      }
      return { nodes };
    }
    if (ids.length) return relationshipConnection(parsed);
    return parsed;
  }

  if (/^\d+$/.test(raw.trim()) && (IMAGE_FIELD.test(field) || field === "ico")) {
    const edge = await mediaEdge(Number(raw));
    if (field === "ico") {
      return edge?.node?.sourceUrl ?? edge?.node?.mediaItemUrl ?? raw;
    }
    return edge;
  }

  if (/^\d+$/.test(raw.trim()) && isProductIdField(field)) {
    return relationshipConnection(raw);
  }

  if (isProductIdField(field) && (raw.includes(",") || raw.includes(" "))) {
    return relationshipConnection(raw);
  }

  return raw;
}

/** Shape a top-level ACF group (camelCase GraphQL object). */
export async function shapeAcfGroup(
  meta: Record<string, string>,
  fields: string[],
  flex?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const flexPrefix = flex?.[field];
    out[snakeToCamel(field)] = await shapeAcfField(meta, field, {
      flexTypePrefix: flexPrefix,
    });
  }
  return out;
}

export function pickMeta(
  meta: Record<string, string>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const v = meta[key];
    if (v != null && v !== "") return v;
  }
  return "";
}
