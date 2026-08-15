import { query, t } from "../db/mysql.js";
import { getRedis } from "../redis/client.js";
import { loadConfig } from "../config.js";
import {
  relationshipConnection,
  shapeAcfField,
  snakeToCamel,
  toPascal,
  unserializeAcf,
} from "./acf.js";
import { logJson } from "../utils/index.js";

export type AcfLocationRule = {
  param: string;
  operator: string;
  value: string;
};

export type AcfFieldDef = {
  id: number;
  name: string;
  type: string;
  graphqlName: string;
  parentId: number;
  parentLayout?: string;
  /** ACF `default_value` when no postmeta is saved (matches WPGraphQL-for-ACF). */
  defaultValue?: string;
  layouts: AcfLayoutDef[];
  subFields: AcfFieldDef[];
};

export type AcfLayoutDef = {
  name: string;
  key?: string;
  graphqlName: string;
  subFields: AcfFieldDef[];
};

export type AcfGraphqlGroup = {
  id: number;
  title: string;
  showInGraphql: boolean;
  graphqlFieldName: string;
  graphqlTypes: string[];
  mapFromLocation: boolean;
  location: AcfLocationRule[][];
  fields: AcfFieldDef[];
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function asStringList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "object") return Object.values(value).map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function parseMaybe(raw: string): unknown {
  if (!raw) return null;
  return unserializeAcf(raw);
}

function parseLocation(raw: unknown): AcfLocationRule[][] {
  if (!Array.isArray(raw)) return [];
  return raw.map((andGroup) => {
    const rules = Array.isArray(andGroup) ? andGroup : Object.values(asRecord(andGroup));
    return rules.map((rule) => {
      const r = asRecord(rule);
      return {
        param: String(r.param ?? ""),
        operator: String(r.operator ?? "=="),
        value: String(r.value ?? ""),
      };
    });
  });
}

/** WPGraphQL `format_type_name`: spaces/hyphens → PascalCase. */
export function graphqlFormatTypeName(name: string): string {
  return name
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/ /g, "");
}

export function graphqlTemplateTypename(templateName: string, templateFile: string): string {
  const fromName = templateName.trim();
  const base =
    fromName && fromName.toLowerCase() !== "default"
      ? fromName
      : templateFile
          .replace(/^.*\//, "")
          .replace(/\.php$/i, "")
          .replace(/^template-?/i, "")
          .replace(/[-_]/g, " ");
  if (!base || base.toLowerCase() === "default") return "DefaultTemplate";
  return `Template_${graphqlFormatTypeName(base)}`;
}

export function pageTemplateTypenames(templateFiles: string[]): string[] {
  const types = new Set<string>();
  for (const file of templateFiles) {
    const typename = graphqlTemplateTypename("", file);
    if (typename !== "DefaultTemplate") types.add(typename);
  }
  return [...types].sort();
}

const knownTemplateTypes = new Set<string>(["DefaultTemplate"]);

export function registerKnownTemplateTypes(types: Iterable<string>): void {
  knownTemplateTypes.clear();
  knownTemplateTypes.add("DefaultTemplate");
  for (const type of types) {
    if (type) knownTemplateTypes.add(type);
  }
}

export function resolveContentTemplateType(typename?: string | null): string {
  if (typename && knownTemplateTypes.has(typename)) return typename;
  return "DefaultTemplate";
}

function templateFileToGraphqlType(file: string): string {
  const base = file
    .replace(/^.*\//, "")
    .replace(/\.php$/i, "")
    .replace(/^template-?/i, "")
    .replace(/[-_]/g, " ");
  if (!base || base.toLowerCase() === "default") return "DefaultTemplate";
  return `Template_${graphqlFormatTypeName(base)}`;
}

function normalizeTemplateSlug(value: string): string {
  return value
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\.php$/i, "")
    .replace(/^template-?/i, "")
    .replace(/^.*\//, "");
}

function templateValueToGraphqlType(value: string): string {
  const slug = normalizeTemplateSlug(value);
  if (!slug || slug === "default") return "DefaultTemplate";
  return `Template_${graphqlFormatTypeName(slug.replace(/[-_]/g, " "))}`;
}

function locationToGraphqlTypes(location: AcfLocationRule[][]): string[] {
  const types = new Set<string>();
  for (const andGroup of location) {
    for (const rule of andGroup) {
      if (
        (rule.param === "page_template" || rule.param === "post_template") &&
        rule.value
      ) {
        types.add(templateFileToGraphqlType(rule.value));
        types.add(templateValueToGraphqlType(rule.value));
      }
      if (rule.param === "post_type" && rule.value === "page") types.add("Page");
      if (rule.param === "post_type" && rule.value === "post") types.add("Post");
      if (rule.param === "post_type" && rule.value === "product") {
        types.add("Product");
        types.add("SimpleProduct");
        types.add("VariableProduct");
      }
    }
  }
  return [...types];
}

function fieldGraphqlName(config: Record<string, unknown>, fallbackName: string): string {
  const explicit = String(config.graphql_field_name ?? "").trim();
  if (explicit) return explicit;
  return snakeToCamel(fallbackName);
}

function parseFieldFromConfig(
  config: Record<string, unknown>,
  id: number,
  parentId: number,
  name: string,
): AcfFieldDef {
  const type = String(config.type ?? "text");
  const layoutsRaw = config.layouts;
  const layoutList = Array.isArray(layoutsRaw)
    ? layoutsRaw
    : layoutsRaw
      ? Object.values(asRecord(layoutsRaw))
      : [];
  const layouts: AcfLayoutDef[] = layoutList.map((layout) => {
    const l = asRecord(layout);
    const layoutName = String(l.name ?? l.key ?? "");
    const subRaw = l.sub_fields;
    const subList = Array.isArray(subRaw) ? subRaw : subRaw ? Object.values(asRecord(subRaw)) : [];
    return {
      name: layoutName,
      key: String(l.key ?? "").trim() || undefined,
      graphqlName: fieldGraphqlName(l, layoutName),
      subFields: subList.map((sub) => {
        const s = asRecord(sub);
        const subName = String(s.name ?? "");
        return parseFieldFromConfig(s, 0, id, subName);
      }),
    };
  });

  const subRaw = config.sub_fields;
  const subList = Array.isArray(subRaw) ? subRaw : subRaw ? Object.values(asRecord(subRaw)) : [];
  const subFields = subList.map((sub) => {
    const s = asRecord(sub);
    const subName = String(s.name ?? "");
    return parseFieldFromConfig(s, 0, id, subName);
  });

  return {
    id,
    name,
    type,
    graphqlName: fieldGraphqlName(config, name),
    parentId,
    parentLayout: String(config.parent_layout ?? "").trim() || undefined,
    defaultValue: acfDefaultValue(config),
    layouts,
    subFields,
  };
}

function acfDefaultValue(config: Record<string, unknown>): string | undefined {
  const raw = config.default_value;
  if (raw == null || raw === false) return undefined;
  const value = String(raw).trim();
  return value || undefined;
}

function withAcfDefault(shaped: unknown, field: AcfFieldDef): unknown {
  if (shaped != null && shaped !== "") return shaped;
  return field.defaultValue ?? null;
}

function attachLayoutChildren(field: AcfFieldDef, directChildren: AcfFieldDef[]): void {
  if (!field.layouts.length) return;

  const layoutByKey = new Map(
    field.layouts.filter((layout) => layout.key).map((layout) => [layout.key!, layout]),
  );

  for (const child of directChildren) {
    const layoutKey = child.parentLayout;
    if (!layoutKey) continue;
    const layout = layoutByKey.get(layoutKey);
    if (!layout) continue;
    if (!layout.subFields.some((existing) => existing.id === child.id)) {
      layout.subFields.push(child);
    }
  }
}

function parseFieldConfig(id: number, parentId: number, name: string, raw: string): AcfFieldDef {
  return parseFieldFromConfig(asRecord(parseMaybe(raw)), id, parentId, name);
}

async function loadAcfGraphqlGroupsUncached(): Promise<AcfGraphqlGroup[]> {
  const groups = await query<
    {
      ID: number;
      post_title: string;
      post_excerpt: string;
      post_content: string;
    }[]
  >(
    `SELECT ID, post_title, post_excerpt, post_content
     FROM ${t("posts")}
     WHERE post_type = 'acf-field-group' AND post_status = 'publish'`,
  );

  const fieldRows = await query<
    {
      ID: number;
      post_parent: number;
      post_excerpt: string;
      post_content: string;
      menu_order: number;
    }[]
  >(
    `SELECT ID, post_parent, post_excerpt, post_content, menu_order
     FROM ${t("posts")}
     WHERE post_type = 'acf-field' AND post_status = 'publish'
     ORDER BY menu_order ASC, ID ASC`,
  );

  const fieldsByParent = new Map<number, AcfFieldDef[]>();
  for (const row of fieldRows) {
    const def = parseFieldConfig(
      row.ID,
      row.post_parent,
      row.post_excerpt || "",
      row.post_content || "",
    );
    const list = fieldsByParent.get(row.post_parent) ?? [];
    list.push(def);
    fieldsByParent.set(row.post_parent, list);
  }

  function attachChildren(def: AcfFieldDef): AcfFieldDef {
    const children = (fieldsByParent.get(def.id) ?? []).map(attachChildren);
    if (def.type === "flexible_content") {
      attachLayoutChildren(def, children);
      return def;
    }
    if (children.length && !def.subFields.length) {
      def.subFields = children;
    }
    return def;
  }

  const out: AcfGraphqlGroup[] = [];
  for (const row of groups) {
    const config = asRecord(parseMaybe(row.post_content || ""));
    const showInGraphql = asBool(config.show_in_graphql);
    if (!showInGraphql) continue;

    const location = parseLocation(config.location);
    const mapFromLocation = asBool(config.map_graphql_types_from_location_rules);
    const explicitTypes = asStringList(config.graphql_types);
    const mapped = locationToGraphqlTypes(location);
    const graphqlTypes = [
      ...new Set(
        explicitTypes.length
          ? mapFromLocation
            ? [...explicitTypes, ...mapped]
            : explicitTypes
          : mapped,
      ),
    ];

    const graphqlFieldName =
      String(config.graphql_field_name ?? "").trim() ||
      snakeToCamel(row.post_excerpt || row.post_title || "");

    const topFields = (fieldsByParent.get(row.ID) ?? []).map(attachChildren);

    out.push({
      id: row.ID,
      title: row.post_title,
      showInGraphql,
      graphqlFieldName,
      graphqlTypes,
      mapFromLocation,
      location,
      fields: topFields,
    });
  }
  return out;
}

const ACF_GROUPS_CACHE_VERSION = "v6";

let memoryGroups: {
  key: string;
  value: AcfGraphqlGroup[];
  expiresAt: number;
} | null = null;
let inflight: Promise<AcfGraphqlGroup[]> | null = null;

function acfGroupsCacheKey(prefix: string): string {
  return `acf:graphql-groups:${ACF_GROUPS_CACHE_VERSION}:${prefix}`;
}

/** Field-group schema changes rarely; keep longer than catalog product TTL. */
function acfGroupsTtlSeconds(): number {
  return Math.max(loadConfig().CATALOG_CACHE_TTL_SECONDS, 3600);
}

export async function loadAcfGraphqlGroups(): Promise<AcfGraphqlGroup[]> {
  const cfg = loadConfig();
  const cacheKey = acfGroupsCacheKey(cfg.MYSQL_TABLE_PREFIX);
  const now = Date.now();
  if (memoryGroups && memoryGroups.key === cacheKey && memoryGroups.expiresAt > now) {
    logJson("info", {
      msg: "acf_groups_cache_hit",
      source: "memory",
      count: memoryGroups.value.length,
    });
    return memoryGroups.value;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const ttl = acfGroupsTtlSeconds();
    const redis = getRedis();
    const hit = await redis.get(cacheKey);
    const source = hit ? "redis" : "mysql";
    const groups = hit
      ? (JSON.parse(hit) as AcfGraphqlGroup[])
      : await loadAcfGraphqlGroupsUncached();
    if (!hit) {
      await redis.set(cacheKey, JSON.stringify(groups), "EX", ttl);
    }
    logJson("info", {
      msg: hit ? "acf_groups_cache_hit" : "acf_groups_loaded_from_mysql",
      source,
      count: groups.length,
      cacheKey,
      ttlSeconds: ttl,
    });
    memoryGroups = {
      key: cacheKey,
      value: groups,
      expiresAt: Date.now() + ttl * 1000,
    };
    return groups;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

function normalizeTemplateFile(file: string): string {
  return file.replace(/^\/+/, "").replace(/\\/g, "/").toLowerCase();
}

function templateFilesMatch(pageFile: string, ruleValue: string): boolean {
  const normalizedPage = normalizeTemplateFile(pageFile);
  const normalizedRule = normalizeTemplateFile(ruleValue);
  if (normalizedPage === normalizedRule) return true;
  if (normalizedPage.endsWith(`/${normalizedRule}`)) return true;
  if (normalizedRule.endsWith(`/${normalizedPage}`)) return true;
  return normalizeTemplateSlug(pageFile) === normalizeTemplateSlug(ruleValue);
}

export function locationMatchesPage(
  group: AcfGraphqlGroup,
  page: { databaseId: number; templateFile: string },
): boolean {
  if (!group.location.length) return false;
  const pageFile = normalizeTemplateFile(page.templateFile);
  return group.location.some((andGroup) =>
    andGroup.every((rule) => {
      if (rule.param === "page_template" || rule.param === "post_template") {
        const eq = templateFilesMatch(pageFile, rule.value);
        return rule.operator === "!=" ? !eq : eq;
      }
      if (rule.param === "page") {
        const eq = String(page.databaseId) === String(rule.value);
        return rule.operator === "!=" ? !eq : eq;
      }
      if (rule.param === "post_type") {
        const eq = rule.value === "page";
        return rule.operator === "!=" ? !eq : eq;
      }
      return true;
    }),
  );
}

export function groupsForGraphqlType(
  groups: AcfGraphqlGroup[],
  typename: string,
): AcfGraphqlGroup[] {
  return groups.filter((g) => g.graphqlTypes.includes(typename));
}

export function resolvePageTemplateType(
  page: { templateName: string; templateFile: string; databaseId: number },
  groups: AcfGraphqlGroup[],
): string {
  const derived = graphqlTemplateTypename(page.templateName, page.templateFile);
  const located = groups.filter((g) => locationMatchesPage(g, page));
  const fromLocation = located
    .flatMap((g) => g.graphqlTypes)
    .find((t) => t.startsWith("Template_"));
  if (fromLocation) return fromLocation;
  if (groups.some((g) => g.graphqlTypes.includes(derived))) return derived;
  return derived;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export async function shapeAcfGroupFields(
  meta: Record<string, string>,
  group: AcfGraphqlGroup,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of group.fields) {
    out[field.graphqlName] = await shapeDefinedField(meta, field, group.graphqlFieldName);
  }
  return out;
}

async function shapeDefinedField(
  meta: Record<string, string>,
  field: AcfFieldDef,
  groupGraphqlName: string,
): Promise<unknown> {
  const flexPrefix = `${toPascal(groupGraphqlName)}${toPascal(field.name)}`;

  if (field.type === "flexible_content") {
    const rows = asArray(
      await shapeAcfField(meta, field.name, { flexTypePrefix: flexPrefix }),
    );
    if (field.layouts.length) {
      return rows.map((row) => {
        if (!row || typeof row !== "object") return row;
        const obj = row as Record<string, unknown>;
        const layoutName = String(obj.fieldGroupName ?? "");
        const layout =
          field.layouts.find((l) => l.name === layoutName) ??
          field.layouts.find((l) => l.graphqlName === layoutName) ??
          field.layouts.find(
            (l) => `${flexPrefix}${toPascal(l.name)}Layout` === layoutName,
          );
        if (layout) {
          const typename = `${flexPrefix}${toPascal(layout.name)}Layout`;
          obj.__typename = typename;
          obj.fieldGroupName = typename;
        } else if (layoutName.endsWith("Layout") && layoutName.startsWith(flexPrefix)) {
          obj.__typename = layoutName;
          obj.fieldGroupName = layoutName;
        }
        return obj;
      });
    }
    return rows;
  }

  if (field.type === "repeater" || field.type === "group") {
    return shapeAcfField(meta, field.name);
  }

  if (
    field.type === "relationship" ||
    field.type === "post_object" ||
    field.type === "page_link" ||
    /products?_?ids$/i.test(field.graphqlName || field.name) ||
    /bestsellerproductids/i.test(field.graphqlName || field.name)
  ) {
    const shaped = await shapeAcfField(meta, field.name);
    if (shaped && typeof shaped === "object") return shaped;
    return relationshipConnection(meta[field.name]);
  }

  if (field.type === "true_false") {
    const raw = meta[field.name];
    if (raw != null && raw !== "") {
      return raw === "1" || raw === "true";
    }
    const fallback = field.defaultValue;
    if (fallback != null) return fallback === "1" || fallback === "true";
    return false;
  }

  if (field.graphqlName === "trustTags" || field.name === "trust_tags") {
    const shaped = await shapeAcfField(meta, field.name);
    if (Array.isArray(shaped)) {
      return shaped.map(String).filter(Boolean).join(", ");
    }
    return withAcfDefault(shaped, field);
  }

  return withAcfDefault(await shapeAcfField(meta, field.name), field);
}
