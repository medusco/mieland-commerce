import { query, queryOne, t, type SqlParam } from "../db/mysql.js";
import {
  getAttachmentUrls,
  getPostMeta,
  getPostMetaKeysMany,
  getPostMetaMany,
  getProductNode,
} from "./products.js";
import { getOption, getOptionsByPrefix } from "./options.js";
import {
  pickMeta,
  relationshipConnection,
  shapeAcfField,
} from "./acf.js";
import {
  groupsForGraphqlType,
  loadAcfGraphqlGroups,
  locationMatchesPage,
  pageTemplateTypenames,
  resolvePageTemplateType,
  shapeAcfGroupFields,
} from "./acf-graphql.js";
import {
  resolveAttachedProductId,
  shapeLabReports,
  shapeManualProduct,
} from "./lab-results-meta.js";
import { toGlobalId } from "../utils/index.js";
import { decodeHtmlEntities } from "../utils/html-entities.js";
import {
  FULL_POST_HYDRATE_NEEDS,
  type PostHydrateNeeds,
} from "../utils/selection.js";

export type PageRecord = {
  databaseId: number;
  title: string;
  slug: string;
  uri: string;
  content: string;
  templateName: string;
  templateFile: string;
  meta: Record<string, string>;
};

function statusWhere(status?: string): string {
  if (!status || status === "PUBLISH" || status === "publish") return "publish";
  return status.toLowerCase();
}

type PostRow = {
  ID: number;
  post_title: string;
  post_name: string;
  post_content: string;
  post_excerpt: string;
  post_date: string | Date;
  post_author: number;
};

type PostTerm = {
  name: string;
  slug: string;
  description: string;
  count?: number;
};

type PostBatchContext = {
  metaByPostId: Map<number, Record<string, string>>;
  termsByPostId: Map<number, { categories: PostTerm[]; tags: PostTerm[] }>;
  authorsById: Map<number, string>;
  imagesByAttachmentId: Map<
    number,
    { sourceUrl: string; mediaItemUrl: string; altText: string }
  >;
  needs: PostHydrateNeeds;
};

function metaKeysForPostNeeds(needs: PostHydrateNeeds): string[] {
  const keys = new Set<string>();
  if (needs.featuredImage) keys.add("_thumbnail_id");
  if (needs.honeyGuideFeatured) {
    keys.add("is_featured");
    keys.add("isFeatured");
  }
  if (needs.honeyGuideRecommended) keys.add("recommended_products");
  if (needs.shopContentBlocks) keys.add("content_blocks");
  return [...keys];
}

function postSelectColumns(needs: PostHydrateNeeds, tableAlias = "p"): string {
  const prefix = tableAlias ? `${tableAlias}.` : "";
  const cols = [
    `${prefix}ID`,
    `${prefix}post_title`,
    `${prefix}post_name`,
    `${prefix}post_date`,
    `${prefix}post_author`,
  ];
  if (needs.excerpt || needs.content) cols.push(`${prefix}post_excerpt`);
  if (needs.content) cols.push(`${prefix}post_content`);
  return cols.join(", ");
}

function mapTermRow(row: {
  name: string;
  slug: string;
  description: string;
  count?: number;
}): PostTerm {
  return {
    ...row,
    name: decodeHtmlEntities(row.name),
    description: row.description
      ? decodeHtmlEntities(row.description)
      : row.description,
  };
}

async function queryTermsMany(
  postIds: number[],
  taxonomies: string[],
): Promise<Map<number, { categories: PostTerm[]; tags: PostTerm[] }>> {
  const out = new Map<number, { categories: PostTerm[]; tags: PostTerm[] }>();
  for (const id of postIds) out.set(id, { categories: [], tags: [] });
  if (!postIds.length || !taxonomies.length) return out;

  const idPh = postIds.map(() => "?").join(",");
  const taxPh = taxonomies.map(() => "?").join(",");
  const rows = await query<
    {
      object_id: number;
      taxonomy: string;
      name: string;
      slug: string;
      description: string;
      count?: number;
    }[]
  >(
    `SELECT tr.object_id, tt.taxonomy, terms.name, terms.slug, tt.description, tt.count
     FROM ${t("term_relationships")} tr
     JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     WHERE tr.object_id IN (${idPh}) AND tt.taxonomy IN (${taxPh})`,
    [...postIds, ...taxonomies],
  );

  for (const row of rows) {
    const bucket = out.get(Number(row.object_id)) ?? { categories: [], tags: [] };
    const term = mapTermRow(row);
    if (row.taxonomy === "category") bucket.categories.push(term);
    if (row.taxonomy === "post_tag") bucket.tags.push(term);
    out.set(Number(row.object_id), bucket);
  }
  return out;
}

async function getAuthorNamesMany(
  authorIds: number[],
): Promise<Map<number, string>> {
  const unique = [...new Set(authorIds.filter((id) => Number.isFinite(id) && id > 0))];
  const out = new Map<number, string>();
  if (!unique.length) return out;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<{ ID: number; display_name: string }[]>(
    `SELECT ID, display_name FROM ${t("users")} WHERE ID IN (${placeholders})`,
    unique,
  );
  for (const row of rows) out.set(Number(row.ID), row.display_name ?? "");
  return out;
}

async function loadPostBatchContext(
  rows: PostRow[],
  needs: PostHydrateNeeds,
): Promise<PostBatchContext> {
  const ids = rows.map((row) => row.ID);
  const metaKeys = metaKeysForPostNeeds(needs);
  const needsFullMeta = needs.shopContentBlocks || needs.honeyGuideRecommended;
  const taxonomies = [
    ...(needs.categories ? (["category"] as const) : []),
    ...(needs.tags ? (["post_tag"] as const) : []),
  ];

  const [metaByPostId, termsByPostId, authorsById] = await Promise.all([
    needsFullMeta
      ? getPostMetaMany(ids)
      : metaKeys.length
        ? getPostMetaKeysMany(ids, metaKeys)
        : Promise.resolve(new Map<number, Record<string, string>>()),
    taxonomies.length
      ? queryTermsMany(ids, [...taxonomies])
      : Promise.resolve(new Map<number, { categories: PostTerm[]; tags: PostTerm[] }>()),
    needs.author
      ? getAuthorNamesMany(rows.map((row) => row.post_author))
      : Promise.resolve(new Map<number, string>()),
  ]);

  let imagesByAttachmentId = new Map<
    number,
    { sourceUrl: string; mediaItemUrl: string; altText: string }
  >();
  if (needs.featuredImage) {
    const thumbIds = [
      ...new Set(
        ids
          .map((id) => Number(metaByPostId.get(id)?._thumbnail_id || 0))
          .filter((id) => id > 0),
      ),
    ];
    if (thumbIds.length) {
      imagesByAttachmentId = await getAttachmentUrls(thumbIds);
    }
  }

  return {
    metaByPostId,
    termsByPostId,
    authorsById,
    imagesByAttachmentId,
    needs,
  };
}

async function shapePostRow(row: PostRow, batch: PostBatchContext) {
  const { needs } = batch;
  const meta = batch.metaByPostId.get(row.ID) ?? {};
  const terms = batch.termsByPostId.get(row.ID) ?? { categories: [], tags: [] };
  const thumbId = Number(meta._thumbnail_id || 0);
  const featuredImage =
    needs.featuredImage && thumbId
      ? (batch.imagesByAttachmentId.get(thumbId) ?? null)
      : null;

  const node: Record<string, unknown> = {
    databaseId: row.ID,
    id: toGlobalId("post", row.ID),
    slug: row.post_name,
    title: decodeHtmlEntities(row.post_title),
    date:
      typeof row.post_date === "string"
        ? row.post_date
        : row.post_date?.toISOString?.() ?? null,
  };

  if (needs.excerpt || needs.content) {
    node.excerpt = row.post_excerpt ?? "";
  }
  if (needs.content) {
    node.content = row.post_content ?? "";
  }
  if (needs.author) {
    node.author = {
      node: { name: batch.authorsById.get(row.post_author) ?? "" },
    };
  }
  if (needs.categories) {
    node.categories = { nodes: terms.categories };
  }
  if (needs.tags) {
    node.tags = { nodes: terms.tags };
  }
  if (needs.featuredImage) {
    node.featuredImage = featuredImage
      ? {
          node: {
            sourceUrl: featuredImage.sourceUrl,
            mediaItemUrl: featuredImage.mediaItemUrl,
            altText: featuredImage.altText,
          },
        }
      : null;
  }

  if (needs.honeyGuideFeatured || needs.honeyGuideRecommended) {
    const honeyGuideFields: Record<string, unknown> = {};
    if (needs.honeyGuideFeatured) {
      honeyGuideFields.isFeatured =
        meta.is_featured === "1" || meta.isFeatured === "1";
    }
    if (needs.honeyGuideRecommended) {
      const recommended = await shapeAcfField(meta, "recommended_products");
      honeyGuideFields.recommendedProducts =
        recommended && typeof recommended === "object"
          ? recommended
          : relationshipConnection(meta.recommended_products);
    }
    node.honeyGuideFields = honeyGuideFields;
  }

  if (needs.shopContentBlocks) {
    node.shopFields = {
      contentBlocks: await shapeAcfField(meta, "content_blocks", {
        flexTypePrefix: "ShopFieldsContentBlocks",
      }),
    };
  }

  return node;
}

export async function listPosts(args: {
  first?: number;
  categoryName?: string;
  status?: string;
  needs?: PostHydrateNeeds;
}) {
  const needs = args.needs ?? FULL_POST_HYDRATE_NEEDS;
  const first = Math.min(args.first ?? 100, 100);
  const status = statusWhere(args.status);
  let sql = `SELECT ${postSelectColumns(needs)}
             FROM ${t("posts")} p`;
  const params: SqlParam[] = [];
  if (args.categoryName) {
    sql += `
      JOIN ${t("term_relationships")} tr ON tr.object_id = p.ID
      JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'category'
      JOIN ${t("terms")} terms ON terms.term_id = tt.term_id AND terms.slug = ?`;
    params.push(args.categoryName);
  }
  sql += ` WHERE p.post_type = 'post' AND p.post_status = ? ORDER BY p.post_date DESC LIMIT ?`;
  params.push(status, first);
  const rows = await query<PostRow[]>(sql, params);
  if (!rows.length) return { nodes: [] };

  const batch = await loadPostBatchContext(rows, needs);
  const nodes = [];
  for (const row of rows) {
    nodes.push(await shapePostRow(row, batch));
  }
  return { nodes };
}

export async function getPostBySlug(
  slug: string,
  needs: PostHydrateNeeds = FULL_POST_HYDRATE_NEEDS,
) {
  const row = await queryOne<PostRow>(
    `SELECT ${postSelectColumns(needs, "")}
     FROM ${t("posts")}
     WHERE post_type = 'post' AND post_name = ? AND post_status = 'publish' LIMIT 1`,
    [slug],
  );
  if (!row) return null;
  const batch = await loadPostBatchContext([row], needs);
  return shapePostRow(row, batch);
}

export async function listCategories(
  first = 50,
  where?: { orderby?: string; order?: string },
) {
  const orderby = (where?.orderby ?? "TERM_ORDER").toUpperCase();
  const order = where?.order?.toUpperCase() === "DESC" ? "DESC" : "ASC";

  const termOrderJoin = `LEFT JOIN (
       SELECT term_id, MIN(CAST(meta_value AS UNSIGNED)) AS sort_order
       FROM ${t("termmeta")}
       WHERE meta_key IN ('order', 'term_order')
       GROUP BY term_id
     ) tm_order ON tm_order.term_id = terms.term_id`;

  let orderClause: string;
  switch (orderby) {
    case "NAME":
      orderClause = `terms.name ${order}`;
      break;
    case "SLUG":
      orderClause = `terms.slug ${order}`;
      break;
    case "COUNT":
      orderClause = `tt.count ${order}`;
      break;
    case "TERM_ORDER":
    default:
      orderClause = `COALESCE(tm_order.sort_order, terms.term_id) ${order}, terms.name ASC`;
      break;
  }

  const join = orderby === "TERM_ORDER" ? termOrderJoin : "";

  const rows = await query<
    { name: string; slug: string; description: string; count: number }[]
  >(
    `SELECT terms.name, terms.slug, tt.description, tt.count
     FROM ${t("term_taxonomy")} tt
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     ${join}
     WHERE tt.taxonomy = 'category'
     ORDER BY ${orderClause}
     LIMIT ?`,
    [first],
  );
  return {
    nodes: rows.map((row) => ({
      ...row,
      name: decodeHtmlEntities(row.name),
      description: row.description ? decodeHtmlEntities(row.description) : row.description,
    })),
  };
}

export async function listProductCategories(first = 100) {
  const rows = await query<
    { name: string; slug: string; badge: string | null }[]
  >(
    `SELECT terms.name, terms.slug, tm.meta_value AS badge
     FROM ${t("term_taxonomy")} tt
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     LEFT JOIN ${t("termmeta")} tm
       ON tm.term_id = terms.term_id AND tm.meta_key = 'badge'
     WHERE tt.taxonomy = 'product_cat'
     ORDER BY terms.name ASC
     LIMIT ?`,
    [first],
  );
  return { nodes: rows };
}

async function pageRowToRecord(row: {
  ID: number;
  post_title: string;
  post_name: string;
  post_content: string;
}): Promise<PageRecord> {
  const meta = await getPostMeta(row.ID);
  const templateFile = meta._wp_page_template || "default";
  return {
    databaseId: row.ID,
    title: row.post_title,
    slug: row.post_name,
    uri: `/${row.post_name}/`,
    content: row.post_content,
    templateName: humanTemplateName(templateFile),
    templateFile,
    meta,
  };
}

function humanTemplateName(file: string): string {
  const base = file.replace(/^.*\//, "").replace(/\.php$/i, "");
  if (!base || base === "default") return "Default";
  return base
    .replace(/^template-?/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function listPageTemplateTypenames(): Promise<string[]> {
  return pageTemplateTypenames(await listPageTemplateFiles());
}

export async function listPageTemplateFiles(): Promise<string[]> {
  const rows = await query<{ meta_value: string }[]>(
    `SELECT DISTINCT pm.meta_value
     FROM ${t("postmeta")} pm
     INNER JOIN ${t("posts")} p ON p.ID = pm.post_id
     WHERE pm.meta_key = '_wp_page_template'
       AND p.post_type = 'page'
       AND p.post_status = 'publish'
       AND pm.meta_value IS NOT NULL
       AND pm.meta_value != ''`,
  );
  return rows.map((row) => row.meta_value).filter(Boolean);
}

export async function listPages(
  first = 100,
  where?: { status?: string; templateName?: string },
) {
  const rows = await query<
    {
      ID: number;
      post_title: string;
      post_name: string;
      post_content: string;
    }[]
  >(
    `SELECT ID, post_title, post_name, post_content FROM ${t("posts")}
     WHERE post_type = 'page' AND post_status = 'publish'
     ORDER BY post_title ASC LIMIT ?`,
    [first],
  );
  const nodes: PageRecord[] = [];
  for (const r of rows) nodes.push(await pageRowToRecord(r));
  const templateFilter = where?.templateName?.trim().toLowerCase();
  const filtered = templateFilter
    ? nodes.filter((page) => page.templateName.trim().toLowerCase() === templateFilter)
    : nodes;
  return { nodes: filtered };
}

export async function getPageByUri(uri: string) {
  const slug = uri.replace(/^\/+|\/+$/g, "").split("/").pop() || uri;
  const row = await queryOne<{
    ID: number;
    post_title: string;
    post_name: string;
    post_content: string;
  }>(
    `SELECT ID, post_title, post_name, post_content FROM ${t("posts")}
     WHERE post_type = 'page' AND post_name = ? AND post_status = 'publish' LIMIT 1`,
    [slug],
  );
  return row ? pageRowToRecord(row) : null;
}

export async function shapePageTemplate(page: PageRecord) {
  const groups = await loadAcfGraphqlGroups();
  const typename = resolvePageTemplateType(page, groups);
  const byType = groupsForGraphqlType(groups, typename);
  const byLocation = groups.filter(
    (g) =>
      locationMatchesPage(g, page) &&
      g.location.some((andGroup) =>
        andGroup.some(
          (rule) =>
            rule.param === "page_template" ||
            rule.param === "post_template" ||
            rule.param === "page",
        ),
      ),
  );
  const attached = [...byType, ...byLocation].filter(
    (g, i, all) => all.findIndex((x) => x.id === g.id) === i,
  );

  const base: Record<string, unknown> = {
    __typename: typename,
    templateName: page.templateName,
  };
  for (const group of attached) {
    base[group.graphqlFieldName] = await shapeAcfGroupFields(page.meta, group);
  }
  return base;
}

function optionsToMeta(options: Record<string, string>, prefix: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const [name, value] of Object.entries(options)) {
    const key = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    meta[key] = value;
  }
  return meta;
}

type AcfLinkShape = { title?: string; url?: string; target?: string } | null;

function asMediaString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "node" in (value as object)) {
    const node = (value as { node?: { sourceUrl?: string; mediaItemUrl?: string } }).node;
    return node?.sourceUrl ?? node?.mediaItemUrl ?? "";
  }
  return "";
}

function normalizeSubmenuLink(link: Record<string, unknown>): Record<string, unknown> {
  const badge = link.linkBadge;
  const linkBadge = Array.isArray(badge)
    ? badge.map(String).filter(Boolean)
    : badge != null && String(badge).trim()
      ? [String(badge)]
      : [];
  return {
    ...link,
    linkBadge,
    link: (link.link as AcfLinkShape) ?? null,
  };
}

function normalizeSubmenuColumn(column: Record<string, unknown>): Record<string, unknown> {
  const links = Array.isArray(column.links)
    ? column.links
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => normalizeSubmenuLink(entry))
    : [];
  return { ...column, links };
}

function normalizeTopLink(item: Record<string, unknown>): Record<string, unknown> {
  const submenuColumns = Array.isArray(item.submenuColumns)
    ? item.submenuColumns
        .filter((column): column is Record<string, unknown> => Boolean(column) && typeof column === "object")
        .map((column) => normalizeSubmenuColumn(column))
    : [];
  const featuredTiles = Array.isArray(item.featuredTiles)
    ? item.featuredTiles.map((tile) => {
        if (!tile || typeof tile !== "object") return tile;
        const row = tile as Record<string, unknown>;
        return {
          ...row,
          image: row.image && typeof row.image === "object" ? row.image : row.image,
        };
      })
    : [];
  return { ...item, submenuColumns, featuredTiles, link: (item.link as AcfLinkShape) ?? null };
}

function normalizeTopMenu(topMenu: unknown): { toplinks: Record<string, unknown>[] } {
  if (Array.isArray(topMenu)) {
    return {
      toplinks: topMenu.filter(
        (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
      ).map((item) => normalizeTopLink(item)),
    };
  }
  if (topMenu && typeof topMenu === "object") {
    const obj = topMenu as Record<string, unknown>;
    const toplinks = Array.isArray(obj.toplinks)
      ? obj.toplinks
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item) => normalizeTopLink(item))
      : [];
    return { toplinks };
  }
  return { toplinks: [] };
}

function normalizeFooter(footer: unknown): Record<string, unknown> {
  const empty = {
    fdaDisclousure: "",
    footerColumns: [],
    footerCopyright: "",
    socialMediaLinks: [],
    subscriptionBox: null,
    trustBadges: [],
  };
  if (!footer || typeof footer !== "object") return empty;

  const obj = footer as Record<string, unknown>;
  const footerColumns = Array.isArray(obj.footerColumns)
    ? obj.footerColumns
        .filter((column): column is Record<string, unknown> => Boolean(column) && typeof column === "object")
        .map((column) => {
          const links = Array.isArray(column.links)
            ? column.links
                .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
                .map((entry) => normalizeSubmenuLink(entry))
            : [];
          return { ...column, links };
        })
    : [];

  const trustBadges = Array.isArray(obj.trustBadges)
    ? obj.trustBadges
        .filter((badge): badge is Record<string, unknown> => Boolean(badge) && typeof badge === "object")
        .map((badge) => ({
          title: typeof badge.title === "string" ? badge.title : "",
          image: asMediaString(badge.image),
        }))
    : [];

  return {
    ...empty,
    ...obj,
    footerColumns,
    trustBadges,
  };
}

function hasNavigationPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  const topMenu = obj.topMenu as { toplinks?: unknown[] } | undefined;
  if (Array.isArray(topMenu?.toplinks) && topMenu.toplinks.length > 0) return true;
  const footer = obj.footer as { footerColumns?: unknown[] } | undefined;
  if (Array.isArray(footer?.footerColumns) && footer.footerColumns.length > 0) return true;
  return false;
}

async function buildNavigationFromOptionsMeta(optionMeta: Record<string, string>) {
  const toplinks = await shapeAcfField(optionMeta, "toplinks");
  const footerColumns = await shapeAcfField(optionMeta, "footer_columns");
  const socialMediaLinks = await shapeAcfField(optionMeta, "social_media_links");
  const subscriptionBox = await shapeAcfField(optionMeta, "subscription_box");
  const trustBadges = await shapeAcfField(optionMeta, "trust_badges");
  const logo = await shapeAcfField(optionMeta, "logo_image");
  const cta = await shapeAcfField(optionMeta, "top_menu_cta");

  return {
    id: "navigation",
    pageTitle: pickMeta(optionMeta, "page_title"),
    menuTitle: pickMeta(optionMeta, "menu_title"),
    topMenu: normalizeTopMenu(toplinks),
    footer: normalizeFooter({
      fdaDisclousure: pickMeta(optionMeta, "fda_disclousure"),
      footerCopyright: pickMeta(optionMeta, "footer_copyright"),
      footerColumns: footerColumns ?? [],
      socialMediaLinks: socialMediaLinks ?? [],
      subscriptionBox: subscriptionBox ?? null,
      trustBadges: trustBadges ?? [],
    }),
    navigationFields: {
      logoImage: asMediaString(logo),
      promoText: pickMeta(optionMeta, "promo_text"),
      topMenuCta: (cta as AcfLinkShape) ?? null,
    },
  };
}

export async function getNavigation() {
  const candidates = ["options_navigation", "navigation", "acf_navigation"];
  for (const name of candidates) {
    const opt = await getOption(name);
    if (opt && typeof opt === "object" && hasNavigationPayload(opt)) {
      const shaped = opt as Record<string, unknown>;
      return {
        id: "navigation",
        ...shaped,
        topMenu: normalizeTopMenu(shaped.topMenu),
        footer: normalizeFooter(shaped.footer),
      };
    }
  }

  const optionMeta = optionsToMeta(await getOptionsByPrefix("options_"), "options_");
  return buildNavigationFromOptionsMeta(optionMeta);
}

export async function searchLabResults(lotNumber: string) {
  const trimmed = lotNumber.trim();
  if (!trimmed) return { nodes: [] };

  const rows = await query<{ ID: number; post_title: string }[]>(
    `SELECT ID, post_title FROM ${t("posts")}
     WHERE post_type = 'lab_results' AND post_status = 'publish'
       AND (post_title = ? OR post_title LIKE ?)
     ORDER BY (post_title = ?) DESC, post_title ASC
     LIMIT 20`,
    [trimmed, `%${trimmed}%`, trimmed],
  );
  const nodes = [];
  for (const r of rows) {
    const meta = await getPostMeta(r.ID);
    const productId = resolveAttachedProductId(meta);
    const product = productId ? await getProductNode(productId) : null;
    const reports = await shapeLabReports(meta);
    const manualProduct = await shapeManualProduct(meta);
    nodes.push({
      title: r.post_title,
      databaseId: r.ID,
      labResultsFields: {
        batchNumber: meta.batch_number || meta.batchNumber || "",
        reports,
        bb: meta.bb || "",
        dateOfEntry: meta.date_of_entry || meta.dateOfEntry || "",
        dha: meta.dha || "",
        npa: meta.npa || "",
        glyphoseteTracesFree: meta.glyphosete_traces_free || "",
        hmf: meta.hmf || "",
        honeyType: meta.honey_type || meta.honeyType || "",
        leptosperin: meta.leptosperin || "",
        manualProduct,
        mfd: meta.mfd || "",
        mgo: meta.mgo || "",
        origin: meta.origin || "",
      },
      attachedProduct: product ? { node: product } : null,
    });
  }
  return { nodes };
}
