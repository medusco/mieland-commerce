import { findUserById } from "../auth/index.js";
import { createWcProductReview } from "../clients/woocommerce-rest.js";
import { query, queryOne, t } from "../db/mysql.js";
import { fromGlobalId, toGlobalId } from "../utils/index.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_REVIEW_FIRST = 10;
const MAX_REVIEW_FIRST = 100;

export type WriteReviewInput = {
  clientMutationId?: string | null;
  commentOn: number;
  rating: number;
  content: string;
  author?: string | null;
  authorEmail?: string | null;
};

export type WrittenReview = {
  clientMutationId: string | null;
  rating: number;
  review: {
    id: string;
    databaseId: number;
    date: string | null;
    content: string;
    status: string;
    karma: number;
    author: { node: { name: string } };
  };
};

function assertValidEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !EMAIL_RE.test(normalized) || normalized.length > 254) {
    throw new Error("A valid email address is required");
  }
  return normalized;
}

async function assertProductExists(productId: number): Promise<void> {
  const row = await queryOne<{ ID: number }>(
    `SELECT ID FROM ${t("posts")}
     WHERE ID = ? AND post_type = 'product' AND post_status = 'publish'
     LIMIT 1`,
    [productId],
  );
  if (!row) {
    throw new Error("Product not found");
  }
}

/**
 * Associate a WC review comment with the authenticated WP user when WC REST
 * created it as a guest (user_id = 0).
 */
async function attachReviewToUser(
  reviewId: number,
  userId: number,
): Promise<void> {
  await query(
    `UPDATE ${t("comments")} SET user_id = ? WHERE comment_ID = ? AND user_id = 0`,
    [userId, reviewId],
  );
}

/**
 * Create a WooCommerce product review for an authenticated customer.
 * Prefers the account name/email; client author fields fill gaps only.
 */
export async function writeProductReview(
  userId: number,
  input: WriteReviewInput,
): Promise<WrittenReview> {
  const productId = Number(input.commentOn);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new Error("A valid product is required");
  }

  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new Error("Please select a rating from 1 to 5 stars");
  }

  const content = String(input.content ?? "").trim();
  if (content.length < 3) {
    throw new Error("Please write a short review");
  }

  const user = await findUserById(userId);
  if (!user) {
    throw new Error("Authentication required");
  }

  await assertProductExists(productId);

  const authorFromAccount = [user.firstName, user.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const reviewer =
    authorFromAccount ||
    user.displayName?.trim() ||
    String(input.author ?? "").trim() ||
    user.username;
  const reviewerEmail = assertValidEmail(
    user.email || String(input.authorEmail ?? ""),
  );

  const created = await createWcProductReview({
    product_id: productId,
    review: content,
    reviewer,
    reviewer_email: reviewerEmail,
    rating,
    status: "hold",
  });

  await attachReviewToUser(created.id, userId);

  return {
    clientMutationId: input.clientMutationId ?? null,
    rating: created.rating,
    review: {
      id: toGlobalId("comment", created.id),
      databaseId: created.id,
      date: created.date_created,
      content: created.review,
      status: created.status,
      karma: created.rating,
      author: { node: { name: created.reviewer } },
    },
  };
}

export type ProductReviewComment = {
  id: string;
  databaseId: number;
  date: string | null;
  content: string;
  status: string;
  karma: number;
  author: { node: { name: string } };
};

export type ProductReviewEdge = {
  cursor: string;
  rating: number;
  node: ProductReviewComment;
};

export type ProductReviewsPageInfo = {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
};

export type ProductReviewsConnection = {
  averageRating: number;
  edges: ProductReviewEdge[];
  pageInfo: ProductReviewsPageInfo;
};

export type ReviewCommentRow = {
  comment_ID: number;
  comment_post_ID: number;
  comment_author: string;
  comment_date: string | Date | null;
  comment_date_gmt: string | Date | null;
  comment_content: string;
  comment_karma: number;
  rating: string | number | null;
};

export function reviewCursor(commentId: number): string {
  return toGlobalId("comment", commentId);
}

export function parseReviewCursor(cursor: string): number | null {
  const g = fromGlobalId(cursor);
  if (g?.type === "comment" && /^\d+$/.test(g.id)) return Number(g.id);
  if (/^\d+$/.test(cursor)) return Number(cursor);
  return null;
}

function formatCommentDate(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
  }
  const s = String(value).trim();
  return s || null;
}

/** Shape a Woo review comment row into a WooGraphQL ProductReviewEdge. */
export function shapeProductReviewEdge(row: ReviewCommentRow): ProductReviewEdge {
  const databaseId = Number(row.comment_ID);
  const ratingRaw = row.rating == null || row.rating === "" ? NaN : Number(row.rating);
  const rating = Number.isFinite(ratingRaw) ? ratingRaw : 0;
  return {
    cursor: reviewCursor(databaseId),
    rating,
    node: {
      id: toGlobalId("comment", databaseId),
      databaseId,
      date: formatCommentDate(row.comment_date_gmt) ?? formatCommentDate(row.comment_date),
      content: row.comment_content ?? "",
      status: "approve",
      karma: Number(row.comment_karma) || 0,
      author: { node: { name: row.comment_author ?? "" } },
    },
  };
}

/**
 * Resolve which product post holds reviews for each id.
 * Variations inherit reviews from their parent product.
 */
export async function resolveProductReviewSourceIds(
  productIds: number[],
): Promise<Map<number, number>> {
  const unique = [
    ...new Set(productIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const sourceById = new Map<number, number>();
  for (const id of unique) sourceById.set(id, id);
  if (!unique.length) return sourceById;

  const placeholders = unique.map(() => "?").join(",");
  const rows = await query<
    { ID: number; post_type: string; post_parent: number }[]
  >(
    `SELECT ID, post_type, post_parent FROM ${t("posts")}
     WHERE ID IN (${placeholders})`,
    unique,
  );
  for (const row of rows) {
    const id = Number(row.ID);
    if (
      row.post_type === "product_variation" &&
      Number(row.post_parent) > 0
    ) {
      sourceById.set(id, Number(row.post_parent));
    } else {
      sourceById.set(id, id);
    }
  }
  return sourceById;
}

/**
 * Batch-load approved Woo product reviews (newest first).
 * One comments+commentmeta query for all product ids; variations map to parents.
 */
export async function getProductReviewsMany(
  productIds: number[],
): Promise<Map<number, ProductReviewEdge[]>> {
  const unique = [
    ...new Set(productIds.filter((id) => Number.isFinite(id) && id > 0)),
  ];
  const out = new Map<number, ProductReviewEdge[]>();
  for (const id of unique) out.set(id, []);
  if (!unique.length) return out;

  const sourceById = await resolveProductReviewSourceIds(unique);
  const sourceIds = [...new Set([...sourceById.values()])];
  if (!sourceIds.length) return out;

  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = await query<ReviewCommentRow[]>(
    `SELECT c.comment_ID, c.comment_post_ID, c.comment_author,
            c.comment_date, c.comment_date_gmt, c.comment_content, c.comment_karma,
            cm.meta_value AS rating
     FROM ${t("comments")} c
     LEFT JOIN ${t("commentmeta")} cm
       ON cm.comment_id = c.comment_ID AND cm.meta_key = 'rating'
     WHERE c.comment_post_ID IN (${placeholders})
       AND c.comment_type = 'review'
       AND c.comment_approved = '1'
     ORDER BY c.comment_date_gmt DESC, c.comment_ID DESC`,
    sourceIds,
  );

  const bySource = new Map<number, ProductReviewEdge[]>();
  for (const id of sourceIds) bySource.set(id, []);
  for (const row of rows) {
    const postId = Number(row.comment_post_ID);
    const list = bySource.get(postId) ?? [];
    list.push(shapeProductReviewEdge(row));
    bySource.set(postId, list);
  }

  for (const id of unique) {
    const sourceId = sourceById.get(id) ?? id;
    out.set(id, bySource.get(sourceId) ?? []);
  }
  return out;
}

/** Apply WooGraphQL-style first/after pagination over preloaded review edges. */
export function paginateProductReviewEdges(
  edges: ProductReviewEdge[],
  args: { first?: number | null; after?: string | null } = {},
): { edges: ProductReviewEdge[]; pageInfo: ProductReviewsPageInfo } {
  const rawFirst = args.first == null ? DEFAULT_REVIEW_FIRST : Number(args.first);
  const first = Number.isFinite(rawFirst)
    ? Math.min(Math.max(Math.trunc(rawFirst), 0), MAX_REVIEW_FIRST)
    : DEFAULT_REVIEW_FIRST;

  let start = 0;
  if (args.after) {
    const afterId = parseReviewCursor(String(args.after));
    if (afterId == null) {
      start = edges.length;
    } else {
      const idx = edges.findIndex((e) => e.node.databaseId === afterId);
      start = idx >= 0 ? idx + 1 : edges.length;
    }
  }

  const sliced = first === 0 ? [] : edges.slice(start, start + first);
  return {
    edges: sliced,
    pageInfo: {
      hasNextPage: start + sliced.length < edges.length,
      hasPreviousPage: start > 0,
      startCursor: sliced[0]?.cursor ?? null,
      endCursor: sliced.length ? sliced[sliced.length - 1]!.cursor : null,
    },
  };
}

export const EMPTY_REVIEW_PAGE_INFO: ProductReviewsPageInfo = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
};
