import { findUserById } from "../auth/index.js";
import { createWcProductReview } from "../clients/woocommerce-rest.js";
import { query, queryOne, t } from "../db/mysql.js";
import { toGlobalId } from "../utils/index.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
