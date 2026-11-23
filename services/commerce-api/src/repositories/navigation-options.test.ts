import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NAVIGATION_OPTION_CANDIDATES,
  pickNavigationOption,
} from "./content.js";
import { loadOptionValuesRaw } from "./options.js";

function navPayload(label: string) {
  return {
    topMenu: { toplinks: [{ label }] },
    footer: { footerColumns: [] },
  };
}

describe("navigation option batching and precedence", () => {
  it("loads multiple option names with one redis MGET and one SQL IN query", async () => {
    const names = [...NAVIGATION_OPTION_CANDIDATES];
    let mgetCalls = 0;
    let queryCalls = 0;
    let queriedNames: string[] = [];

    const values = await loadOptionValuesRaw(names, {
      tablePrefix: "hy_",
      ttlSeconds: 60,
      memoryGet: () => undefined,
      memorySet: () => {},
      redisMget: async (keys) => {
        mgetCalls += 1;
        assert.equal(keys.length, names.length);
        return keys.map(() => null);
      },
      redisSetMany: async () => {},
      queryByNames: async (misses) => {
        queryCalls += 1;
        queriedNames = [...misses];
        return [
          {
            option_name: "options_navigation",
            option_value: JSON.stringify(navPayload("primary")),
          },
        ];
      },
    });

    assert.equal(mgetCalls, 1);
    assert.equal(queryCalls, 1);
    assert.deepEqual(queriedNames, names);
    assert.equal(
      values.get("options_navigation"),
      JSON.stringify(navPayload("primary")),
    );
    assert.equal(values.get("navigation"), null);
    assert.equal(values.get("acf_navigation"), null);
  });

  it("keeps options_navigation → navigation → acf_navigation precedence", () => {
    const allPresent = new Map<string, unknown>([
      ["options_navigation", navPayload("from-options")],
      ["navigation", navPayload("from-navigation")],
      ["acf_navigation", navPayload("from-acf")],
    ]);
    assert.equal(
      pickNavigationOption(allPresent)?.name,
      "options_navigation",
    );

    const skipEmpty = new Map<string, unknown>([
      ["options_navigation", { topMenu: { toplinks: [] }, footer: {} }],
      ["navigation", navPayload("from-navigation")],
      ["acf_navigation", navPayload("from-acf")],
    ]);
    assert.equal(pickNavigationOption(skipEmpty)?.name, "navigation");

    const acfOnly = new Map<string, unknown>([
      ["options_navigation", null],
      ["navigation", { topMenu: { toplinks: [] } }],
      ["acf_navigation", navPayload("from-acf")],
    ]);
    assert.equal(pickNavigationOption(acfOnly)?.name, "acf_navigation");

    assert.equal(pickNavigationOption(new Map()), null);
  });

  it("serves memory hits without redis or SQL", async () => {
    let mgetCalls = 0;
    let queryCalls = 0;
    const store = new Map<string, string>([
      ["opt:hy_:options_navigation", JSON.stringify(navPayload("cached"))],
      ["opt:hy_:navigation", "__null__"],
      ["opt:hy_:acf_navigation", "__null__"],
    ]);

    const values = await loadOptionValuesRaw([...NAVIGATION_OPTION_CANDIDATES], {
      tablePrefix: "hy_",
      ttlSeconds: 60,
      memoryGet: (key) => store.get(key),
      memorySet: () => {},
      redisMget: async () => {
        mgetCalls += 1;
        return [];
      },
      redisSetMany: async () => {},
      queryByNames: async () => {
        queryCalls += 1;
        return [];
      },
    });

    assert.equal(mgetCalls, 0);
    assert.equal(queryCalls, 0);
    assert.equal(
      values.get("options_navigation"),
      JSON.stringify(navPayload("cached")),
    );
    assert.equal(values.get("navigation"), null);
  });
});
