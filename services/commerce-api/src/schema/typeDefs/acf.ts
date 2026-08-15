import type { AcfFieldDef, AcfGraphqlGroup } from "../../repositories/acf-graphql.js";
import {
  graphqlTemplateTypename,
  registerKnownTemplateTypes,
  shapeAcfGroupFields,
} from "../../repositories/acf-graphql.js";
import { getPostMeta } from "../../repositories/products.js";
import { toPascal } from "../../repositories/acf.js";
import type { PageRecord } from "../../repositories/content.js";
import { logJson } from "../../utils/index.js";

const SKIP_TYPES = new Set(["tab", "accordion", "message", "separator"]);

const PRODUCT_GRAPHQL_TYPES = new Set([
  "Product",
  "SimpleProduct",
  "VariableProduct",
  "SimpleProductVariation",
]);

/** WPGraphQL type names that differ from commerce SDL. */
const PRODUCT_GRAPHQL_TYPE_ALIASES: Record<string, string> = {
  SimpleProductVariation: "ProductVariation",
};

/** Fields already declared on base Product interface — ACF only supplies the nested type + resolver. */
const BASE_PRODUCT_FIELDS = new Set(["thumbnailFields"]);

function resolveProductGraphqlType(graphqlType: string): string | null {
  if (!PRODUCT_GRAPHQL_TYPES.has(graphqlType)) return null;
  if (graphqlType === "Product") return "Product";
  return PRODUCT_GRAPHQL_TYPE_ALIASES[graphqlType] ?? graphqlType;
}

function productExtensionSdl(typename: string, fields: string[]): string | null {
  const unique = [...new Set(fields)];
  if (!unique.length) return null;
  if (typename === "Product") {
    return `  extend interface Product {\n${unique.join("\n")}\n  }`;
  }
  return `  extend type ${typename} {\n${unique.join("\n")}\n  }`;
}

export type AcfSchemaBuildSummary = {
  totalGroups: number;
  activeGroups: number;
  skippedGroups: Array<{
    title: string;
    graphqlFieldName: string;
    reason: string;
  }>;
  emittedTypes: string[];
  layoutInterfaces: Array<{ name: string; members: string[] }>;
  templateTypes: string[];
  pageFields: string[];
  postFields: string[];
  sdlLength: number;
};

export type AcfSchemaBuildResult = {
  sdl: string;
  summary: AcfSchemaBuildSummary;
};

type EmitContext = {
  emitted: Map<string, string>;
  interfaces: Map<string, string[]>;
};

function gqlName(name: string): string {
  const pascal = toPascal(name.replace(/[^a-zA-Z0-9_]/g, "_"));
  return pascal || "AcfType";
}

function groupTypeName(group: AcfGraphqlGroup): string {
  return gqlName(group.graphqlFieldName);
}

function flexBaseName(parentType: string, field: AcfFieldDef): string {
  return `${parentType}${gqlName(field.graphqlName || field.name)}`;
}

function layoutTypeName(flexBase: string, layoutName: string): string {
  return `${flexBase}${gqlName(layoutName)}Layout`;
}

function scalarForAcfType(type: string): string {
  switch (type) {
    case "true_false":
      return "Boolean";
    case "number":
    case "range":
      return "Float";
    case "image":
    case "file":
      return "MediaItemEdge";
    case "gallery":
      return "MediaItemConnection";
    case "link":
      return "AcfLink";
    case "relationship":
    case "post_object":
    case "page_link":
      return "AcfContentNodeConnection";
    case "checkbox":
      return "[String]";
    default:
      return "String";
  }
}

/** WPGraphQL-for-ACF field typing with commerce overrides for known CMS fields. */
function scalarForField(field: AcfFieldDef): string {
  const name = field.graphqlName || field.name;
  if (name === "productThumbnailImage") {
    return "ProductThumbnailImage";
  }
  if (/products?_?ids$/i.test(name) || /bestsellerproductids/i.test(name)) {
    return "AcfContentNodeConnection";
  }
  if (name === "trustTags" || name === "trust_tags") {
    return "String";
  }
  return scalarForAcfType(field.type);
}

function emitObjectType(
  typeName: string,
  fields: AcfFieldDef[],
  extraFields: string[],
  ctx: EmitContext,
  options?: { flexBasePrefix?: string; implementsInterface?: string },
): void {
  if (ctx.emitted.has(typeName)) return;

  const lines: string[] = [...extraFields];
  for (const field of fields) {
    if (SKIP_TYPES.has(field.type) || !field.graphqlName) continue;
    const gqlType = fieldGraphQLType(typeName, field, ctx, options?.flexBasePrefix);
    lines.push(`    ${field.graphqlName}: ${gqlType}`);
  }

  const implementsClause = options?.implementsInterface
    ? ` implements ${options.implementsInterface}`
    : "";
  ctx.emitted.set(
    typeName,
    `  type ${typeName}${implementsClause} {\n${lines.join("\n")}\n  }`,
  );
}

function fieldGraphQLType(
  parentType: string,
  field: AcfFieldDef,
  ctx: EmitContext,
  flexBasePrefix?: string,
): string {
  if (field.type === "flexible_content") {
    const flexBase = flexBaseName(parentType, field);
    const interfaceName = `${flexBase}_Layout`;
    const members: string[] = [];

    for (const layout of field.layouts) {
      const layoutType = layoutTypeName(flexBase, layout.name);
      emitObjectType(
        layoutType,
        layout.subFields,
        ["    fieldGroupName: String"],
        ctx,
        { flexBasePrefix: flexBase, implementsInterface: interfaceName },
      );
      members.push(layoutType);
    }

    if (!members.length) return "[String]";
    ctx.interfaces.set(interfaceName, members);
    return `[${interfaceName}]`;
  }

  if (field.type === "repeater" || field.type === "group") {
    const prefix = flexBasePrefix ?? parentType;
    const nested = `${prefix}${gqlName(field.graphqlName || field.name)}`;
    emitObjectType(nested, field.subFields, [], ctx, { flexBasePrefix });
    return field.type === "repeater" ? `[${nested}]` : nested;
  }

  return scalarForField(field);
}

function collectTemplateTypes(groups: AcfGraphqlGroup[]): Map<string, AcfGraphqlGroup[]> {
  const map = new Map<string, AcfGraphqlGroup[]>();
  for (const group of groups) {
    for (const t of group.graphqlTypes) {
      if (!t.startsWith("Template_")) continue;
      const list = map.get(t) ?? [];
      list.push(group);
      map.set(t, list);
    }
  }
  return map;
}

/** SDL for ACF field groups (WPGraphQL-for-ACF settings). */
export function buildAcfSchema(
  groups: AcfGraphqlGroup[],
  pageTemplateFiles: string[] = [],
): AcfSchemaBuildResult {
  const ctx: EmitContext = {
    emitted: new Map<string, string>(),
    interfaces: new Map<string, string[]>(),
  };
  const pageFields: string[] = [];
  const postFields: string[] = [];
  const productFields = new Map<string, string[]>();
  const skippedGroups: AcfSchemaBuildSummary["skippedGroups"] = [];
  const templates = collectTemplateTypes(groups);
  for (const file of pageTemplateFiles) {
    const typename = graphqlTemplateTypename("", file);
    if (typename === "DefaultTemplate" || templates.has(typename)) continue;
    templates.set(typename, []);
  }

  for (const group of groups) {
    const typeName = groupTypeName(group);
    emitObjectType(typeName, group.fields, [], ctx);
    const fieldLine = `    ${group.graphqlFieldName}: ${typeName}`;
    if (group.graphqlTypes.includes("Page")) pageFields.push(fieldLine);
    if (group.graphqlTypes.includes("Post")) postFields.push(fieldLine);
    for (const graphqlType of group.graphqlTypes) {
      const resolvedType = resolveProductGraphqlType(graphqlType);
      if (!resolvedType) continue;
      if (resolvedType === "Product" && BASE_PRODUCT_FIELDS.has(group.graphqlFieldName)) {
        continue;
      }
      const list = productFields.get(resolvedType) ?? [];
      list.push(fieldLine);
      productFields.set(resolvedType, list);
    }
  }

  const templateSdl: string[] = [];
  const templateTypes: string[] = [];
  for (const [typename, attached] of templates) {
    templateTypes.push(typename);
    const unique = attached.filter((g, i, a) => a.findIndex((x) => x.id === g.id) === i);
    const fields = unique.map(
      (g) => `    ${g.graphqlFieldName}: ${groupTypeName(g)}`,
    );
    templateSdl.push(
      `  type ${typename} implements ContentTemplate {\n    templateName: String\n${fields.join("\n")}\n  }`,
    );
  }

  const interfaceSdl = [...ctx.interfaces.keys()].map(
    (name) => `  interface ${name} {\n    fieldGroupName: String\n  }`,
  );

  const parts = [
    ...interfaceSdl,
    ...ctx.emitted.values(),
    ...templateSdl,
  ];
  if (pageFields.length) {
    parts.push(`  extend type Page {\n${[...new Set(pageFields)].join("\n")}\n  }`);
  }
  if (postFields.length) {
    parts.push(`  extend type Post {\n${[...new Set(postFields)].join("\n")}\n  }`);
  }
  for (const [typename, fields] of [...productFields.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const block = productExtensionSdl(typename, fields);
    if (block) parts.push(block);
  }

  const sdl = `  ${parts.join("\n\n")}`;

  registerKnownTemplateTypes(templateTypes);

  return {
    sdl,
    summary: {
      totalGroups: groups.length,
      activeGroups: groups.length,
      skippedGroups,
      emittedTypes: [...ctx.emitted.keys()].sort(),
      layoutInterfaces: [...ctx.interfaces.entries()]
        .map(([name, members]) => ({ name, members: [...members].sort() }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      templateTypes: templateTypes.sort(),
      pageFields: [...new Set(pageFields.map((line) => line.trim()))].sort(),
      postFields: [...new Set(postFields.map((line) => line.trim()))].sort(),
      sdlLength: sdl.length,
    },
  };
}

export function logAcfSchemaBuild(summary: AcfSchemaBuildSummary): void {
  logJson("info", {
    msg: "acf_schema_generated",
    totalGroups: summary.totalGroups,
    activeGroups: summary.activeGroups,
    skippedGroups: summary.skippedGroups,
    emittedTypeCount: summary.emittedTypes.length,
    emittedTypes: summary.emittedTypes,
    layoutInterfaceCount: summary.layoutInterfaces.length,
    layoutInterfaces: summary.layoutInterfaces,
    templateTypes: summary.templateTypes,
    pageFieldCount: summary.pageFields.length,
    postFieldCount: summary.postFields.length,
    sdlLength: summary.sdlLength,
  });
}

function productAcfFieldResolver(group: AcfGraphqlGroup) {
  return async (product: { databaseId?: number }) => {
    const id = product.databaseId;
    if (!id) return null;
    const meta = await getPostMeta(id);
    return shapeAcfGroupFields(meta, group);
  };
}

export function generateAcfTypeDefs(groups: AcfGraphqlGroup[]): string {
  return buildAcfSchema(groups).sdl;
}

export function generateAcfResolvers(
  groups: AcfGraphqlGroup[],
): Record<string, Record<string, unknown>> {
  const resolvers: Record<string, Record<string, unknown>> = {};

  const pageGroups = groups.filter((g) => g.graphqlTypes.includes("Page"));
  if (pageGroups.length) {
    resolvers.Page = {};
    for (const group of pageGroups) {
      resolvers.Page[group.graphqlFieldName] = (page: PageRecord) =>
        shapeAcfGroupFields(page.meta, group);
    }
  }

  const postGroups = groups.filter((g) => g.graphqlTypes.includes("Post"));
  if (postGroups.length) {
    resolvers.Post = {};
    for (const group of postGroups) {
      resolvers.Post[group.graphqlFieldName] = (post: {
        _acfMeta?: Record<string, string>;
        honeyGuideFields?: unknown;
        shopFields?: unknown;
      }) => {
        if (group.graphqlFieldName === "honeyGuideFields" && post.honeyGuideFields) {
          return post.honeyGuideFields;
        }
        if (group.graphqlFieldName === "shopFields" && post.shopFields) {
          return post.shopFields;
        }
        if (post._acfMeta) return shapeAcfGroupFields(post._acfMeta, group);
        return null;
      };
    }
  }

  const thumbnailGroup = groups.find((g) => g.graphqlFieldName === "thumbnailFields");
  if (thumbnailGroup) {
    resolvers.Product = {
      ...(resolvers.Product ?? {}),
      thumbnailFields: productAcfFieldResolver(thumbnailGroup),
    };
  }

  for (const group of groups) {
    const productTargets = new Set<string>();
    for (const graphqlType of group.graphqlTypes) {
      const resolvedType = resolveProductGraphqlType(graphqlType);
      if (!resolvedType) continue;
      if (resolvedType === "Product" && BASE_PRODUCT_FIELDS.has(group.graphqlFieldName)) {
        continue;
      }
      productTargets.add(resolvedType);
    }
    for (const typeName of productTargets) {
      resolvers[typeName] = {
        ...(resolvers[typeName] ?? {}),
        [group.graphqlFieldName]: productAcfFieldResolver(group),
      };
    }
  }

  const layoutResolve = (obj: { __typename?: string }) =>
    obj.__typename ?? "DefaultTemplate";

  for (const group of groups) {
    const parent = groupTypeName(group);
    for (const field of group.fields) {
      if (field.type !== "flexible_content") continue;
      const interfaceName = `${flexBaseName(parent, field)}_Layout`;
      resolvers[interfaceName] = { __resolveType: layoutResolve };
    }
  }

  return resolvers;
}
