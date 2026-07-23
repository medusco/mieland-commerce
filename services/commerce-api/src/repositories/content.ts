import { query, queryOne, t, type SqlParam } from "../db/mysql.js";
import { getAttachmentUrl, getPostMeta, getProductNode } from "./products.js";
import { getOption, phpUnserialize } from "./options.js";
import { toGlobalId } from "../utils/index.js";

function statusWhere(status?: string): string {
  if (!status || status === "PUBLISH" || status === "publish") return "publish";
  return status.toLowerCase();
}

async function shapePost(row: {
  ID: number;
  post_title: string;
  post_name: string;
  post_content: string;
  post_excerpt: string;
  post_date: string | Date;
  post_author: number;
}) {
  const meta = await getPostMeta(row.ID);
  const thumbId = Number(meta._thumbnail_id || 0);
  const featuredImage = thumbId ? await getAttachmentUrl(thumbId) : null;
  const author = await queryOne<{ display_name: string }>(
    `SELECT display_name FROM ${t("users")} WHERE ID = ?`,
    [row.post_author],
  );
  const categories = await queryTerms(row.ID, "category");
  const tags = await queryTerms(row.ID, "post_tag");

  return {
    databaseId: row.ID,
    id: toGlobalId("post", row.ID),
    slug: row.post_name,
    title: row.post_title,
    excerpt: row.post_excerpt,
    content: row.post_content,
    date:
      typeof row.post_date === "string"
        ? row.post_date
        : row.post_date?.toISOString?.() ?? null,
    author: { node: { name: author?.display_name ?? "" } },
    categories: { nodes: categories },
    tags: { nodes: tags },
    featuredImage: featuredImage
      ? {
          node: {
            sourceUrl: featuredImage.sourceUrl,
            mediaItemUrl: featuredImage.mediaItemUrl,
            altText: featuredImage.altText,
          },
        }
      : null,
    honeyGuideFields: {
      isFeatured: meta.is_featured === "1" || meta.isFeatured === "1",
    },
  };
}

async function queryTerms(postId: number, taxonomy: string) {
  return query<{ name: string; slug: string; description: string; count?: number }[]>(
    `SELECT terms.name, terms.slug, tt.description, tt.count
     FROM ${t("term_relationships")} tr
     JOIN ${t("term_taxonomy")} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     WHERE tr.object_id = ? AND tt.taxonomy = ?`,
    [postId, taxonomy],
  );
}

export async function listPosts(args: {
  first?: number;
  categoryName?: string;
  status?: string;
}) {
  const first = Math.min(args.first ?? 100, 100);
  const status = statusWhere(args.status);
  let sql = `SELECT p.ID, p.post_title, p.post_name, p.post_content, p.post_excerpt, p.post_date, p.post_author
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
  const rows = await query<
    {
      ID: number;
      post_title: string;
      post_name: string;
      post_content: string;
      post_excerpt: string;
      post_date: string | Date;
      post_author: number;
    }[]
  >(sql, params);
  const nodes = [];
  for (const r of rows) nodes.push(await shapePost(r));
  return { nodes };
}

export async function getPostBySlug(slug: string) {
  const row = await queryOne<{
    ID: number;
    post_title: string;
    post_name: string;
    post_content: string;
    post_excerpt: string;
    post_date: string | Date;
    post_author: number;
  }>(
    `SELECT ID, post_title, post_name, post_content, post_excerpt, post_date, post_author
     FROM ${t("posts")} WHERE post_type = 'post' AND post_name = ? AND post_status = 'publish' LIMIT 1`,
    [slug],
  );
  return row ? shapePost(row) : null;
}

export async function listCategories(first = 50) {
  const rows = await query<
    { name: string; slug: string; description: string; count: number }[]
  >(
    `SELECT terms.name, terms.slug, tt.description, tt.count
     FROM ${t("term_taxonomy")} tt
     JOIN ${t("terms")} terms ON terms.term_id = tt.term_id
     WHERE tt.taxonomy = 'category'
     ORDER BY terms.term_order ASC, terms.name ASC
     LIMIT ?`,
    [first],
  );
  return { nodes: rows };
}

export async function listPages(first = 100) {
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
  const nodes = [];
  for (const r of rows) {
    const meta = await getPostMeta(r.ID);
    nodes.push({
      databaseId: r.ID,
      title: r.post_title,
      slug: r.post_name,
      content: r.post_content,
      template: { templateName: meta._wp_page_template || "default" },
      homepageFields: await shapeHomepageFields(meta),
    });
  }
  return { nodes };
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
  if (!row) return null;
  const meta = await getPostMeta(row.ID);
  return {
    databaseId: row.ID,
    title: row.post_title,
    slug: row.post_name,
    content: row.post_content,
    template: { templateName: meta._wp_page_template || "default" },
  };
}

/** Best-effort ACF homepage fields from postmeta (JSON or PHP serialized). */
async function shapeHomepageFields(meta: Record<string, string>) {
  // If ACF stores as individual keys, surface a minimal structure; full flexible content
  // is stored in serialized form under field keys — attempt JSON option first.
  const raw = meta.homepage_fields || meta.homepageFields;
  if (raw) {
    try {
      if (raw.startsWith("a:") || raw.startsWith("{")) {
        const parsed =
          raw.startsWith("{") ? JSON.parse(raw) : phpUnserialize(raw);
        return parsed;
      }
    } catch {
      /* fallthrough */
    }
  }
  return {
    heroBanner: null,
    pageBlocks: [],
  };
}

export async function getNavigation() {
  // ACF options often live as option `options_navigation` or similar
  const candidates = [
    "options_navigation",
    "navigation",
    "acf_navigation",
  ];
  for (const name of candidates) {
    const opt = await getOption(name);
    if (opt && typeof opt === "object") {
      return { id: "navigation", ...(opt as object) };
    }
  }
  return {
    id: "navigation",
    pageTitle: "",
    menuTitle: "",
    topMenu: { toplinks: [] },
    footer: {
      fdaDisclousure: "",
      footerColumns: [],
      footerCopyright: "",
      socialMediaLinks: [],
      subscriptionBox: null,
      trustBadges: [],
    },
    navigationFields: {
      logoImage: null,
      promoText: "",
      topMenuCta: null,
    },
  };
}

export async function searchLabResults(lotNumber: string) {
  const like = `%${lotNumber}%`;
  const rows = await query<
    { ID: number; post_title: string }[]
  >(
    `SELECT ID, post_title FROM ${t("posts")}
     WHERE post_type = 'lab_results' AND post_status = 'publish' AND post_title LIKE ?
     LIMIT 20`,
    [like],
  );
  const nodes = [];
  for (const r of rows) {
    const meta = await getPostMeta(r.ID);
    const productId = Number(meta.attached_product || meta.attachedProduct || 0);
    const product = productId ? await getProductNode(productId) : null;
    nodes.push({
      title: r.post_title,
      databaseId: r.ID,
      labResultsFields: {
        batchNumber: meta.batch_number || meta.batchNumber || "",
        reports: [],
        bb: meta.bb || "",
        dateOfEntry: meta.date_of_entry || meta.dateOfEntry || "",
        dha: meta.dha || "",
        npa: meta.npa || "",
        glyphoseteTracesFree: meta.glyphosete_traces_free || "",
        hmf: meta.hmf || "",
        honeyType: meta.honey_type || meta.honeyType || "",
        leptosperin: meta.leptosperin || "",
        manualProduct: null,
        mfd: meta.mfd || "",
        mgo: meta.mgo || "",
        origin: meta.origin || "",
      },
      attachedProduct: product ? { node: product } : null,
    });
  }
  return { nodes };
}
