import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execute, parse } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import type { Executor } from "@graphql-tools/utils";
import { buildStitchedSchema, createWpExecutor, memoryCache } from "./wp-navigation.js";

const local = makeExecutableSchema({
  typeDefs: `type NavigationLink { title: String url: String target: String }
    type Navigation { id: ID termsOfService: NavigationLink privacyPolicy: NavigationLink }
    type Product { id: ID }
    type Query { navigation: Navigation product: Product }`,
  resolvers: { Query: { product: () => ({ id: "p1" }) } },
});

const remoteSchema = (withLegal: boolean) =>
  makeExecutableSchema({
    typeDefs: `type AcfLink { title: String url: String target: String }
      type Product { id: ID wpOnly: String }
      type Navigation { id: ID ${withLegal ? "termsOfService: AcfLink privacyPolicy: AcfLink" : ""} brandNewField: String }
      type Query { navigation: Navigation product: Product }`,
    resolvers: {
      Query: {
        navigation: () => ({
          id: "nav",
          brandNewField: "from-wp",
          termsOfService: { title: "Terms", url: "https://x/terms", target: null },
          privacyPolicy: { title: "Privacy", url: "https://x/privacy", target: "_blank" },
        }),
      },
    },
  });

const execOn = (schema: ReturnType<typeof remoteSchema>, state = { down: false, calls: 0 }): Executor =>
  (async (req) => {
    state.calls++;
    if (state.down) throw new Error("WP down");
    return execute({ schema, document: req.document, variableValues: req.variables });
  }) as Executor;

const fallback = async () => ({
  id: "db",
  termsOfService: { title: "DB Terms", url: "/t", target: null },
  privacyPolicy: null,
});

describe("wp navigation forwarding", () => {
  it("passes new WP fields through and keeps local fields", async () => {
    const r = await buildStitchedSchema({ local, executor: execOn(remoteSchema(true)), fallbackNavigation: fallback });
    assert.ok(r.schema);
    const res = await execute({
      schema: r.schema,
      document: parse(`{ navigation { brandNewField termsOfService { title url target } privacyPolicy { url target } } product { id } }`),
    });
    assert.equal(res.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(res.data)), {
      navigation: {
        brandNewField: "from-wp",
        termsOfService: { title: "Terms", url: "https://x/terms", target: null },
        privacyPolicy: { url: "https://x/privacy", target: "_blank" },
      },
      product: { id: "p1" },
    });
  });

  it("falls back to the DB reader when WP fails at request time", async () => {
    const state = { down: false, calls: 0 };
    const r = await buildStitchedSchema({ local, executor: execOn(remoteSchema(true), state), fallbackNavigation: fallback });
    assert.ok(r.schema);
    state.down = true;
    const res = await execute({ schema: r.schema, document: parse(`{ navigation { termsOfService { title } } }`) });
    assert.equal(res.errors, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(res.data)), { navigation: { termsOfService: { title: "DB Terms" } } });
  });

  it("refuses to stitch when WP lacks fields the storefront uses", async () => {
    const r = await buildStitchedSchema({ local, executor: execOn(remoteSchema(false)), fallbackNavigation: fallback });
    assert.equal(r.schema, null);
    assert.match(String((r as { reason: string }).reason), /navigation\.termsOfService/);
  });

  it("refuses to stitch when introspection fails", async () => {
    const r = await buildStitchedSchema({ local, executor: execOn(remoteSchema(true), { down: true, calls: 0 }), fallbackNavigation: fallback });
    assert.equal(r.schema, null);
  });

  it("http executor sends Origin and caches query responses", async () => {
    let calls = 0;
    let origin: string | null = null;
    const fetcher = (async (_u: string, init: RequestInit) => {
      calls++;
      origin = (init.headers as Record<string, string>).Origin;
      return new Response(JSON.stringify({ data: { navigation: { id: "n" } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const ex = createWpExecutor({ url: "http://wp/graphql", origin: "https://shop.test", timeoutMs: 1000, cache: memoryCache, cacheTtlSeconds: 60, fetcher });
    const req = { document: parse(`{ navigation { id cacheTest: id } }`), operationType: "query" } as never;
    await ex(req);
    const second = await ex(req);
    assert.equal(calls, 1);
    assert.equal(origin, "https://shop.test");
    assert.deepEqual(second, { data: { navigation: { id: "n" } } });
  });
});
