import { query } from "../db/mysql.js";
import { t } from "../db/mysql.js";
import { loadConfig } from "../config.js";
import { getOption, getOptionString } from "./options.js";
import { toGlobalId } from "../utils/index.js";
import { decodeHtmlEntities } from "../utils/html-entities.js";
import { memoryGet, memorySet } from "../utils/memory-cache.js";

/**
 * WPGraphQL-compatible `menuItems(where: { location })`.
 * Reads WordPress menus straight from MySQL (same pattern as other content repos):
 *   theme_mods_<stylesheet>.nav_menu_locations[location] -> nav_menu term_id
 *   -> nav_menu_item posts in that term (+ _menu_item_* postmeta).
 */

export const MENU_LOCATIONS: Record<string, string> = {
  FOOTER: "footer",
  PRIMARY: "primary",
};

export type MenuItemNode = {
  id: string;
  databaseId: number;
  label: string;
  url: string;
  uri: string;
  order: number;
  target: string | null;
  parentDatabaseId: number;
  locations: string[];
};

type ItemRow = {
  ID: number;
  post_title: string;
  menu_order: number;
  meta_key: string | null;
  meta_value: string | null;
};

type ObjRow = { ID: number; post_title: string; post_name: string; post_type: string; post_parent: number };

/** Path-only uri for a URL on the site; external URLs return the URL unchanged. */
export function urlToUri(url: string, siteUrl: string): string {
  if (!url) return "";
  if (url.startsWith("/")) return url;
  try {
    const u = new URL(url);
    const site = siteUrl ? new URL(siteUrl) : null;
    if (site && u.host === site.host) return `${u.pathname}${u.search}${u.hash}` || "/";
    return url;
  } catch {
    return url;
  }
}

export function shapeMenuItems(
  rows: ItemRow[],
  objects: Map<number, ObjRow>,
  siteUrl: string,
  locationEnum: string,
): MenuItemNode[] {
  const byId = new Map<number, { row: ItemRow; meta: Record<string, string> }>();
  for (const r of rows) {
    let e = byId.get(r.ID);
    if (!e) {
      e = { row: r, meta: {} };
      byId.set(r.ID, e);
    }
    if (r.meta_key) e.meta[r.meta_key] = r.meta_value ?? "";
  }
  const base = siteUrl.replace(/\/$/, "");
  const nodes: MenuItemNode[] = [];
  for (const { row, meta } of byId.values()) {
    const type = meta._menu_item_type ?? "custom";
    const objId = Number(meta._menu_item_object_id || 0);
    const obj = type === "post_type" ? objects.get(objId) : undefined;
    let uri = "";
    let url = "";
    if (type === "custom") {
      url = meta._menu_item_url ?? "";
      uri = urlToUri(url, siteUrl);
    } else if (obj) {
      uri = obj.post_type === "page" || obj.post_type === "post" ? `/${obj.post_name}/` : `/${obj.post_type}/${obj.post_name}/`;
      url = `${base}${uri}`;
    } else {
      continue; // object missing / unpublished / taxonomy not supported
    }
    const label = decodeHtmlEntities(row.post_title || obj?.post_title || "");
    const target = meta._menu_item_target ? meta._menu_item_target : null;
    nodes.push({
      id: toGlobalId("post", row.ID),
      databaseId: row.ID,
      label,
      url,
      uri,
      order: Number(row.menu_order) || 0,
      target,
      parentDatabaseId: Number(meta._menu_item_menu_item_parent || 0),
      locations: [locationEnum],
    });
  }
  return nodes.sort((a, b) => a.order - b.order);
}

export async function getMenuItemsByLocation(locationEnum: string): Promise<MenuItemNode[]> {
  const slug = MENU_LOCATIONS[locationEnum];
  if (!slug) return [];
  const cfg = loadConfig();
  const cacheKey = `menu:${cfg.tablePrefix}:${slug}`;
  const hit = memoryGet(cacheKey);
  if (hit !== undefined) return JSON.parse(hit) as MenuItemNode[];

  const stylesheet = await getOptionString("stylesheet");
  const mods = await getOption<Record<string, unknown>>(`theme_mods_${stylesheet}`);
  const locs = (mods?.nav_menu_locations ?? {}) as Record<string, unknown>;
  const termId = Number(locs[slug] ?? 0);
  let nodes: MenuItemNode[] = [];
  if (termId > 0) {
    const rows = await query<ItemRow[]>(
      `SELECT p.ID, p.post_title, p.menu_order, pm.meta_key, pm.meta_value
       FROM ${t("posts")} p
       JOIN ${t("term_relationships")} tr ON tr.object_id = p.ID
       JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         AND tt.taxonomy = 'nav_menu' AND tt.term_id = ?
       LEFT JOIN ${t("postmeta")} pm ON pm.post_id = p.ID AND pm.meta_key LIKE '\\_menu\\_item\\_%'
       WHERE p.post_type = 'nav_menu_item' AND p.post_status = 'publish'`,
      [termId],
    );
    const objIds = [
      ...new Set(
        rows
          .filter((r) => r.meta_key === "_menu_item_object_id")
          .map((r) => Number(r.meta_value))
          .filter((n) => n > 0),
      ),
    ];
    const objects = new Map<number, ObjRow>();
    if (objIds.length) {
      const objRows = await query<ObjRow[]>(
        `SELECT ID, post_title, post_name, post_type, post_parent FROM ${t("posts")}
         WHERE ID IN (${objIds.map(() => "?").join(",")}) AND post_status = 'publish'`,
        objIds,
      );
      for (const o of objRows) objects.set(o.ID, o);
    }
    const siteUrl = (await getOptionString("home")) || cfg.WORDPRESS_URL || "";
    nodes = shapeMenuItems(rows, objects, siteUrl, locationEnum);
  }
  memorySet(cacheKey, JSON.stringify(nodes));
  return nodes;
}
