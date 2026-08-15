import type { AcfFieldDef, AcfGraphqlGroup } from "../../repositories/acf-graphql.js";
import { shapeAcfGroupFields } from "../../repositories/acf-graphql.js";
import { toPascal } from "../../repositories/acf.js";
import type { PageRecord } from "../../repositories/content.js";

const SKIP_TYPES = new Set(["tab", "accordion", "message", "separator"]);

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
export function generateAcfTypeDefs(groups: AcfGraphqlGroup[]): string {
  const ctx: EmitContext = {
    emitted: new Map<string, string>(),
    interfaces: new Map<string, string[]>(),
  };
  const pageFields: string[] = [];
  const postFields: string[] = [];
  const templates = collectTemplateTypes(groups);

  for (const group of groups) {
    const typeName = groupTypeName(group);
    emitObjectType(typeName, group.fields, [], ctx);
    const fieldLine = `    ${group.graphqlFieldName}: ${typeName}`;
    if (group.graphqlTypes.includes("Page")) pageFields.push(fieldLine);
    if (group.graphqlTypes.includes("Post")) postFields.push(fieldLine);
  }

  const templateSdl: string[] = [];
  for (const [typename, attached] of templates) {
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

  return `  ${parts.join("\n\n")}`;
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
