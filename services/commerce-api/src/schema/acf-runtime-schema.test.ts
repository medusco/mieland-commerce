import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  introspectionFromSchema,
  type IntrospectionObjectType,
} from "graphql";
import type { AcfGraphqlGroup } from "../repositories/acf-graphql.js";
import type { AcfFieldDef } from "../repositories/acf-graphql.js";
import {
  buildInitialAcfExecutableSchema,
  createAcfSchemaSwapTarget,
  enqueueAcfSchemaRefresh,
} from "./acf-runtime-schema.js";

function field(
  partial: Partial<AcfFieldDef> & Pick<AcfFieldDef, "name" | "type" | "graphqlName">,
): AcfFieldDef {
  return {
    id: partial.id ?? 1,
    parentId: partial.parentId ?? 0,
    layouts: partial.layouts ?? [],
    subFields: partial.subFields ?? [],
    ...partial,
  };
}

function baseGroup(extraField?: AcfFieldDef): AcfGraphqlGroup {
  const fields = [
    field({ name: "hero_title", type: "text", graphqlName: "heroTitle" }),
  ];
  if (extraField) fields.push(extraField);
  return {
    id: 1,
    title: "Home",
    showInGraphql: true,
    graphqlFieldName: "homeFields",
    graphqlTypes: ["Page"],
    mapFromLocation: false,
    location: [],
    fields,
  };
}

function pageHasField(schema: import("graphql").GraphQLSchema, fieldName: string): boolean {
  const introspection = introspectionFromSchema(schema);
  const page = introspection.__schema.types.find(
    (t): t is IntrospectionObjectType =>
      t.name === "Page" && t.kind === "OBJECT",
  );
  const fields = page?.fields ?? [];
  return fields.some((f) => f.name === fieldName);
}

describe("acf runtime schema swap", () => {
  it("swap exposes a new Page field after rebuild", async () => {
    const initial = await buildInitialAcfExecutableSchema([baseGroup()], {
      templateFiles: [],
    });
    const swap = createAcfSchemaSwapTarget(initial.schema);
    assert.equal(pageHasField(swap.getSchema(), "homeFields"), true);
    assert.equal(pageHasField(swap.getSchema(), "announcementFields"), false);

    const withAnnouncement: AcfGraphqlGroup = {
      ...baseGroup(),
      id: 2,
      title: "Announcement",
      graphqlFieldName: "announcementFields",
      fields: [
        field({ name: "banner_text", type: "text", graphqlName: "bannerText" }),
      ],
    };
    const rebuilt = await buildInitialAcfExecutableSchema(
      [baseGroup(), withAnnouncement],
      { templateFiles: [] },
    );
    swap.setSchema(rebuilt.schema);

    assert.equal(pageHasField(swap.getSchema(), "announcementFields"), true);
  });

  it("buildInitial schema exposes ACF group on Page", async () => {
    const { schema } = await buildInitialAcfExecutableSchema([baseGroup()], {
      templateFiles: [],
    });
    assert.equal(pageHasField(schema, "homeFields"), true);
  });

  it("serialized refresh keeps previous schema when rebuild fails", async () => {
    const { schema } = await buildInitialAcfExecutableSchema([baseGroup()], {
      templateFiles: [],
    });
    const swap = createAcfSchemaSwapTarget(schema);
    const before = swap.getSchema();

    const fail = await enqueueAcfSchemaRefresh(swap, async () => {
      throw new Error("redis down");
    });
    assert.equal(fail.ok, false);
    assert.equal(swap.getSchema(), before);
  });
});