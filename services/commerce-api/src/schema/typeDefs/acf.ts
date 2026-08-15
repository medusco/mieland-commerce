import type { AcfFieldDef, AcfGraphqlGroup } from "../../repositories/acf-graphql.js";
import { shapeAcfGroupFields } from "../../repositories/acf-graphql.js";
import { toPascal } from "../../repositories/acf.js";
import type { PageRecord } from "../../repositories/content.js";

const SKIP_TYPES = new Set(["tab", "accordion", "message", "separator"]);

function gqlName(name: string): string {
  const pascal = toPascal(name.replace(/[^a-zA-Z0-9_]/g, "_"));
  return pascal || "AcfType";
}

function groupTypeName(group: AcfGraphqlGroup): string {
  return gqlName(group.graphqlFieldName);
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

function emitObjectType(
  typeName: string,
  fields: AcfFieldDef[],
  extraFields: string[],
  emitted: Map<string, string>,
  unions: Map<string, string[]>,
): void {
  if (emitted.has(typeName)) return;
  emitted.set(typeName, "");
  const lines: string[] = [...extraFields];
  for (const field of fields) {
    if (SKIP_TYPES.has(field.type) || !field.graphqlName) continue;
    const gqlType = fieldGraphQLType(typeName, field, emitted, unions);
    lines.push(`    ${field.graphqlName}: ${gqlType}`);
  }
  emitted.set(
    typeName,
    `  type ${typeName} {\n${lines.join("\n")}\n  }`,
  );
}

function fieldGraphQLType(
  parentType: string,
  field: AcfFieldDef,
  emitted: Map<string, string>,
  unions: Map<string, string[]>,
): string {
  if (field.type === "flexible_content") {
    const unionName = `${parentType}${gqlName(field.graphqlName || field.name)}`;
    const members: string[] = [];
    for (const layout of field.layouts) {
      const layoutType = `${unionName}${gqlName(layout.name)}Layout`;
      emitObjectType(
        layoutType,
        layout.subFields,
        ["    fieldGroupName: String"],
        emitted,
        unions,
      );
      members.push(layoutType);
    }
    if (!members.length) return "[String]";
    unions.set(unionName, members);
    return `[${unionName}]`;
  }

  if (field.type === "repeater" || field.type === "group") {
    const nested = `${parentType}${gqlName(field.graphqlName || field.name)}`;
    emitObjectType(nested, field.subFields, [], emitted, unions);
    return field.type === "repeater" ? `[${nested}]` : nested;
  }

  return scalarForAcfType(field.type);
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
  const emitted = new Map<string, string>();
  const unions = new Map<string, string[]>();
  const pageFields: string[] = [];
  const postFields: string[] = [];
  const templates = collectTemplateTypes(groups);

  for (const group of groups) {
    const typeName = groupTypeName(group);
    emitObjectType(typeName, group.fields, [], emitted, unions);
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

  const unionSdl = [...unions.entries()].map(
    ([name, members]) => `  union ${name} = ${members.join(" | ")}`,
  );

  const parts = [
    ...emitted.values(),
    ...unionSdl,
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

  const unionResolve = (obj: { __typename?: string; fieldGroupName?: string }) =>
    obj.__typename ?? "DefaultTemplate";

  for (const group of groups) {
    const parent = groupTypeName(group);
    for (const field of group.fields) {
      if (field.type !== "flexible_content") continue;
      const unionName = `${parent}${gqlName(field.graphqlName || field.name)}`;
      resolvers[unionName] = { __resolveType: unionResolve };
    }
  }

  return resolvers;
}
