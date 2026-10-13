/**
 * Dynamic `Navigation` type built from ACF field definitions in the DB.
 *
 * - Field groups (`acf-field-group` posts) whose location rules target the
 *   Navigation options page become fields on `Navigation` (group graphql name,
 *   camelCase). Their fields (`acf-field` posts: post_excerpt = name,
 *   post_content = serialized config, post_parent = group/parent field) define
 *   the GraphQL type; values come from `options_*` rows in the options table.
 * - Storefront stability: base fields (id, pageTitle, menuTitle, termsOfService,
 *   privacyPolicy) are always present. For groups whose field name already
 *   exists in the legacy static shape (topMenu, footer, navigationFields), the
 *   generated type is used only if it is a superset of the static type;
 *   otherwise that field keeps the static type and legacy reader (logged).
 */
import { Kind, parse, print, type ObjectTypeDefinitionNode, type TypeNode } from "graphql";
import type { AcfFieldDef, AcfGraphqlGroup } from "../repositories/acf-graphql.js";
import { acfGraphqlTypeName, emitAcfTypes, scalarForField } from "./typeDefs/acf.js";

export const STATIC_NAVIGATION_SDL = `
  type Navigation {
    id: ID
    termsOfService: NavigationLink
    privacyPolicy: NavigationLink
    pageTitle: String
    menuTitle: String
    topMenu: NavigationTopMenu
    footer: NavigationFooter
    navigationFields: NavigationFields
  }
`;

const BASE_FIELDS = new Set(["id", "termsOfService", "privacyPolicy", "pageTitle", "menuTitle"]);
const SKIP_TYPES = new Set(["tab", "accordion", "message", "separator"]);

export type NavigationPlanEntry =
  | { field: string; mode: "acf"; group: AcfGraphqlGroup }
  | { field: string; mode: "static" };

export type NavigationSchemaBuild = {
  sdl: string;
  plan: NavigationPlanEntry[];
  mismatches: Record<string, string[]>;
};

/** True when any location rule targets the Navigation options page. */
export function isNavigationGroup(group: AcfGraphqlGroup, pageSlug = "navigation"): boolean {
  const slug = pageSlug.toLowerCase();
  return group.location.some((and) =>
    and.some(
      (r) =>
        r.param === "options_page" &&
        r.operator !== "!=" &&
        r.value.toLowerCase().replace(/^acf-options-/, "") === slug,
    ),
  );
}

type ObjMap = Map<string, ObjectTypeDefinitionNode>;

function objectTypes(sdl: string): ObjMap {
  const map: ObjMap = new Map();
  for (const d of parse(sdl).definitions) {
    if (d.kind === Kind.OBJECT_TYPE_DEFINITION) map.set(d.name.value, d);
  }
  return map;
}

function unwrap(t: TypeNode): { list: boolean; named: string } {
  let cur = t;
  if (cur.kind === Kind.NON_NULL_TYPE) cur = cur.type;
  const list = cur.kind === Kind.LIST_TYPE;
  while (cur.kind !== Kind.NAMED_TYPE) cur = cur.type;
  return { list, named: cur.name.value };
}

/** Paths of static fields that the generated ACF definition cannot serve with the same type. */
export function staticCompat(types: ObjMap, staticType: ObjectTypeDefinitionNode, fields: AcfFieldDef[], path: string): string[] {
  const out: string[] = [];
  for (const sf of staticType.fields ?? []) {
    const name = sf.name.value;
    if (name === "fieldGroupName") continue;
    const def = fields.find((f) => f.graphqlName === name && !SKIP_TYPES.has(f.type));
    const p = `${path}.${name}`;
    if (!def) {
      out.push(`${p} (missing)`);
      continue;
    }
    const st = unwrap(sf.type);
    const obj = types.get(st.named);
    if (def.type === "repeater" || def.type === "group") {
      const wantList = def.type === "repeater";
      if (st.list !== wantList || !obj) {
        out.push(`${p} (${def.type} vs ${print(sf.type)})`);
        continue;
      }
      out.push(...staticCompat(types, obj, def.subFields, p));
      continue;
    }
    if (def.type === "flexible_content") {
      out.push(`${p} (flexible_content)`);
      continue;
    }
    const gen = scalarForField(def);
    const genList = gen.startsWith("[");
    const genNamed = gen.replace(/[[\]!]/g, "");
    if (genList !== st.list || genNamed !== st.named) {
      out.push(`${p} (${gen} vs ${print(sf.type)})`);
    }
  }
  return out;
}

/**
 * @param baseTypeDefs static SDL without `type Navigation` (still defines the legacy Navigation* subtypes).
 */
export function buildNavigationSchema(
  groups: AcfGraphqlGroup[],
  baseTypeDefs: string,
): NavigationSchemaBuild {
  const types = objectTypes(`${baseTypeDefs}\n${STATIC_NAVIGATION_SDL}`);
  const staticFields = Object.fromEntries(
    (types.get("Navigation")?.fields ?? []).map((fd) => [fd.name.value, fd]),
  );

  const lines = [
    "    id: ID",
    "    termsOfService: NavigationLink",
    "    privacyPolicy: NavigationLink",
    "    pageTitle: String",
    "    menuTitle: String",
  ];
  const plan: NavigationPlanEntry[] = [];
  const mismatches: Record<string, string[]> = {};
  const roots: Array<{ typeName: string; fields: AcfFieldDef[] }> = [];
  const used = new Set(BASE_FIELDS);

  for (const group of groups) {
    const field = group.graphqlFieldName;
    if (!field || used.has(field)) continue;
    used.add(field);
    const typeName = `NavigationAcf${acfGraphqlTypeName(field)}`;
    const legacy = staticFields[field];
    if (legacy) {
      const named = types.get(unwrap(legacy.type).named);
      const miss = named ? staticCompat(types, named, group.fields, field) : [`${field} (not object)`];
      if (miss.length) {
        mismatches[field] = miss;
        lines.push(`    ${field}: ${print(legacy.type)}`);
        plan.push({ field, mode: "static" });
        continue;
      }
    }
    roots.push({ typeName, fields: group.fields });
    lines.push(`    ${field}: ${typeName}`);
    plan.push({ field, mode: "acf", group });
  }

  // Legacy fields the CMS no longer defines stay available via the static reader.
  for (const [name, f] of Object.entries(staticFields)) {
    if (used.has(name)) continue;
    used.add(name);
    lines.push(`    ${name}: ${print(f.type)}`);
    plan.push({ field: name, mode: "static" });
  }

  const nested = roots.length ? emitAcfTypes(roots) : "";
  const sdl = `${nested}\n\n  type Navigation {\n${lines.join("\n")}\n  }\n`;
  return { sdl, plan, mismatches };
}

/** Interfaces emitted for flexible content need __resolveType. */
export function navigationInterfaceResolvers(sdl: string): Record<string, { __resolveType: (o: { __typename?: string }) => string | null }> {
  const out: Record<string, { __resolveType: (o: { __typename?: string }) => string | null }> = {};
  for (const m of sdl.matchAll(/interface (\w+)/g)) {
    out[m[1]] = { __resolveType: (o) => o?.__typename ?? null };
  }
  return out;
}

export type NavigationDeps = {
  legacy: () => Promise<Record<string, unknown>>;
  optionMeta: () => Promise<Record<string, string>>;
  shapeGroup: (meta: Record<string, string>, group: AcfGraphqlGroup) => Promise<Record<string, unknown>>;
};

export async function resolveNavigation(
  plan: NavigationPlanEntry[],
  deps: NavigationDeps,
): Promise<Record<string, unknown>> {
  const legacy = await deps.legacy();
  const out: Record<string, unknown> = {
    id: legacy.id ?? "navigation",
    pageTitle: legacy.pageTitle ?? null,
    menuTitle: legacy.menuTitle ?? null,
    termsOfService: legacy.termsOfService ?? null,
    privacyPolicy: legacy.privacyPolicy ?? null,
  };
  const acf = plan.filter((p) => p.mode === "acf");
  const meta = acf.length ? await deps.optionMeta() : {};
  for (const entry of plan) {
    out[entry.field] =
      entry.mode === "acf" ? await deps.shapeGroup(meta, entry.group) : (legacy[entry.field] ?? null);
  }
  return out;
}
