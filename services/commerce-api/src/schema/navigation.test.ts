import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphql } from "graphql";
import { makeExecutableSchema } from "@graphql-tools/schema";
import type { AcfFieldDef, AcfGraphqlGroup } from "../repositories/acf-graphql.js";
import { shapeAcfGroupFields } from "../repositories/acf-graphql.js";
import { typeDefs } from "./typeDefs/index.js";
import {
  buildNavigationSchema,
  isNavigationGroup,
  navigationInterfaceResolvers,
  resolveNavigation,
} from "./navigation.js";

let id = 1;
const f = (name: string, type: string, subFields: AcfFieldDef[] = []): AcfFieldDef => ({
  id: id++, name, type, graphqlName: name.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
  parentId: 0, layouts: [], subFields,
});
const group = (graphqlFieldName: string, fields: AcfFieldDef[], value = "navigation"): AcfGraphqlGroup => ({
  id: id++, title: graphqlFieldName, showInGraphql: true, graphqlFieldName, graphqlTypes: [],
  mapFromLocation: false, location: [[{ param: "options_page", operator: "==", value }]], fields,
});

const s = (v: string) => `s:${Buffer.byteLength(v, "utf8")}:"${v}";`;
const link = (title: string, url: string, target: string) =>
  `a:3:{${s("title")}${s(title)}${s("url")}${s(url)}${s("target")}${s(target)}}`;

const navLink = () => [f("link", "link"), f("link_badge", "checkbox"), f("submenu_title", "text")];
const footerGroup = (extra: AcfFieldDef[] = []) =>
  group("footer", [
    f("fda_disclousure", "textarea"),
    f("footer_columns", "repeater", [f("footer_column_title", "text"), f("links", "repeater", navLink())]),
    f("footer_copyright", "text"),
    f("social_media_links", "repeater", [f("icon", "text"), f("link", "link")]),
    f("subscription_box", "group", [f("button_title", "text"), f("disclaimer", "text"), f("field_group_name", "text"), f("subtitle", "text"), f("title", "text")]),
    f("trust_badges", "repeater", [f("image", "text"), f("title", "text")]),
    ...extra,
  ]);

const legacy = async () => ({
  id: "navigation", pageTitle: "Nav", menuTitle: "Nav",
  termsOfService: { title: "Terms", url: "https://x/terms", target: null },
  privacyPolicy: { title: "Privacy", url: "https://x/privacy", target: "_blank" },
  topMenu: { toplinks: [{ menuTitle: "Shop" }] },
  footer: { footerCopyright: "legacy" },
  navigationFields: { promoText: "legacy promo" },
});

function run(groups: AcfGraphqlGroup[], meta: Record<string, string>, query: string) {
  const nav = buildNavigationSchema(groups, typeDefs);
  const schema = makeExecutableSchema({
    // ThumbnailFields normally comes from generated product ACF SDL.
    typeDefs: [typeDefs, nav.sdl, "type ThumbnailFields { fieldGroupName: String }"],
    resolvers: {
      ...navigationInterfaceResolvers(nav.sdl),
      Query: {
        navigation: () => resolveNavigation(nav.plan, { legacy, optionMeta: async () => meta, shapeGroup: shapeAcfGroupFields }),
      },
    },
  });
  return { nav, exec: () => graphql({ schema, source: query }) };
}

describe("dynamic navigation schema", () => {
  it("matches only groups on the Navigation options page", () => {
    assert.equal(isNavigationGroup(group("a", [])), true);
    assert.equal(isNavigationGroup(group("a", [], "acf-options-navigation")), true);
    assert.equal(isNavigationGroup(group("a", [], "site-settings")), false);
  });

  it("without CMS groups keeps the legacy static shape", async () => {
    const { nav, exec } = run([], {}, `{ navigation { id termsOfService { url } topMenu { toplinks { menuTitle } } footer { footerCopyright } navigationFields { promoText } } }`);
    assert.deepEqual(nav.plan.map((p) => p.mode), ["static", "static", "static"]);
    const r = await exec();
    assert.equal(r.errors, undefined);
    assert.equal((r.data as any).navigation.footer.footerCopyright, "legacy");
    assert.equal((r.data as any).navigation.termsOfService.url, "https://x/terms");
  });

  it("serves a compatible group from ACF defs + options, including new fields", async () => {
    const { nav, exec } = run(
      [footerGroup([f("new_cms_field", "text"), f("help_link", "link")])],
      {
        footer_copyright: "© Mieland",
        new_cms_field: "hello",
        help_link: link("Help", "https://x/help", ""),
        footer_columns: "1",
        footer_columns_0_footer_column_title: "Shop",
        footer_columns_0_links: "1",
        footer_columns_0_links_0_link: link("Honey", "/honey", ""),
        footer_columns_0_links_0_submenu_title: "Raw",
      },
      `{ navigation { termsOfService { title } footer { footerCopyright newCmsField helpLink { title url } footerColumns { footerColumnTitle links { link { url } submenuTitle } } } } }`,
    );
    assert.deepEqual(nav.mismatches, {});
    assert.equal(nav.plan.find((p) => p.field === "footer")?.mode, "acf");
    const r = await exec();
    assert.equal(r.errors, undefined, JSON.stringify(r.errors));
    const footer = (r.data as any).navigation.footer;
    assert.equal(footer.footerCopyright, "© Mieland");
    assert.equal(footer.newCmsField, "hello");
    assert.deepEqual({ ...footer.helpLink }, { title: "Help", url: "https://x/help" });
    assert.equal(footer.footerColumns[0].footerColumnTitle, "Shop");
    assert.equal(footer.footerColumns[0].links[0].link.url, "/honey");
    assert.equal((r.data as any).navigation.termsOfService.title, "Terms");
  });

  it("adds brand-new groups as Navigation fields", async () => {
    const { exec } = run(
      [group("announcementBar", [f("message", "text"), f("cta", "link")])],
      { message: "Free shipping", cta: link("Shop", "/shop", "_self") },
      `{ navigation { announcementBar { message cta { title url target } } footer { footerCopyright } } }`,
    );
    const r = await exec();
    assert.equal(r.errors, undefined, JSON.stringify(r.errors));
    assert.equal((r.data as any).navigation.announcementBar.message, "Free shipping");
    assert.equal((r.data as any).navigation.announcementBar.cta.target, "_self");
    assert.equal((r.data as any).navigation.footer.footerCopyright, "legacy");
  });

  it("keeps the static type when the CMS group would change the storefront shape", () => {
    const { nav } = run([group("navigationFields", [f("logo_image", "image"), f("promo_text", "text"), f("top_menu_cta", "link")])], {}, "{ __typename }");
    assert.equal(nav.plan.find((p) => p.field === "navigationFields")?.mode, "static");
    assert.match(nav.mismatches.navigationFields.join(), /logoImage/);
  });
});
