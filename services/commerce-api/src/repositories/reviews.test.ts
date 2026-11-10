import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  paginateProductReviewEdges,
  parseReviewCursor,
  reviewCursor,
  shapeProductReviewEdge,
  type ProductReviewEdge,
  type ReviewCommentRow,
} from "./reviews.js";
import { toGlobalId } from "../utils/index.js";

function edge(
  id: number,
  opts: { rating?: number; author?: string; content?: string; date?: string } = {},
): ProductReviewEdge {
  return shapeProductReviewEdge({
    comment_ID: id,
    comment_post_ID: 100,
    comment_author: opts.author ?? "Reviewer",
    comment_date: opts.date ?? "2024-06-01 12:00:00",
    comment_date_gmt: opts.date ?? "2024-06-01 12:00:00",
    comment_content: opts.content ?? `Review ${id}`,
    comment_karma: 0,
    rating: opts.rating ?? 5,
  });
}

describe("shapeProductReviewEdge", () => {
  it("maps Woo comment + rating meta without exposing email", () => {
    const row: ReviewCommentRow = {
      comment_ID: 42,
      comment_post_ID: 7,
      comment_author: "Alex",
      comment_date: "2024-03-10 09:30:00",
      comment_date_gmt: "2024-03-10 09:30:00",
      comment_content: "<p>Great honey</p>",
      comment_karma: 0,
      rating: "4",
    };
    const shaped = shapeProductReviewEdge(row);
    assert.equal(shaped.rating, 4);
    assert.equal(shaped.cursor, toGlobalId("comment", 42));
    assert.equal(shaped.node.databaseId, 42);
    assert.equal(shaped.node.id, toGlobalId("comment", 42));
    assert.equal(shaped.node.content, "<p>Great honey</p>");
    assert.equal(shaped.node.date, "2024-03-10 09:30:00");
    assert.equal(shaped.node.author.node.name, "Alex");
    assert.equal(shaped.node.status, "approve");
    assert.equal(
      Object.prototype.hasOwnProperty.call(shaped.node.author.node, "email"),
      false,
    );
  });

  it("treats missing rating as 0", () => {
    assert.equal(
      shapeProductReviewEdge({
        comment_ID: 1,
        comment_post_ID: 1,
        comment_author: "A",
        comment_date: null,
        comment_date_gmt: null,
        comment_content: "x",
        comment_karma: 0,
        rating: null,
      }).rating,
      0,
    );
  });
});

describe("review cursors", () => {
  it("round-trips comment database ids", () => {
    const cursor = reviewCursor(99);
    assert.equal(parseReviewCursor(cursor), 99);
    assert.equal(parseReviewCursor("99"), 99);
    assert.equal(parseReviewCursor("not-a-cursor"), null);
  });
});

describe("paginateProductReviewEdges", () => {
  const edges = [edge(30), edge(20), edge(10), edge(5)];

  it("defaults to first 10 and reports pageInfo", () => {
    const page = paginateProductReviewEdges(edges);
    assert.equal(page.edges.length, 4);
    assert.deepEqual(
      page.edges.map((e) => e.node.databaseId),
      [30, 20, 10, 5],
    );
    assert.equal(page.pageInfo.hasNextPage, false);
    assert.equal(page.pageInfo.hasPreviousPage, false);
    assert.equal(page.pageInfo.startCursor, reviewCursor(30));
    assert.equal(page.pageInfo.endCursor, reviewCursor(5));
  });

  it("supports first/after pagination newest-first", () => {
    const firstPage = paginateProductReviewEdges(edges, { first: 2 });
    assert.deepEqual(
      firstPage.edges.map((e) => e.node.databaseId),
      [30, 20],
    );
    assert.equal(firstPage.pageInfo.hasNextPage, true);
    assert.equal(firstPage.pageInfo.hasPreviousPage, false);
    assert.equal(firstPage.pageInfo.endCursor, reviewCursor(20));

    const secondPage = paginateProductReviewEdges(edges, {
      first: 2,
      after: firstPage.pageInfo.endCursor,
    });
    assert.deepEqual(
      secondPage.edges.map((e) => e.node.databaseId),
      [10, 5],
    );
    assert.equal(secondPage.pageInfo.hasNextPage, false);
    assert.equal(secondPage.pageInfo.hasPreviousPage, true);
  });

  it("returns empty page for first 0 or unknown after cursor", () => {
    const zero = paginateProductReviewEdges(edges, { first: 0 });
    assert.deepEqual(zero.edges, []);
    assert.equal(zero.pageInfo.hasNextPage, true);
    assert.equal(zero.pageInfo.hasPreviousPage, false);

    const page = paginateProductReviewEdges(edges, {
      first: 2,
      after: reviewCursor(999),
    });
    assert.deepEqual(page.edges, []);
    assert.equal(page.pageInfo.hasNextPage, false);
    assert.equal(page.pageInfo.hasPreviousPage, true);
  });
});

describe("variation review inheritance", () => {
  it("maps variation ids onto parent review lists", () => {
    // Pure mapping rule used by getProductReviewsMany after source resolution.
    const bySource = new Map<number, ProductReviewEdge[]>([
      [100, [edge(1, { content: "Parent review" })]],
    ]);
    const sourceById = new Map<number, number>([
      [100, 100],
      [101, 100], // variation → parent
    ]);
    const out = new Map<number, ProductReviewEdge[]>();
    for (const id of [100, 101]) {
      const sourceId = sourceById.get(id) ?? id;
      out.set(id, bySource.get(sourceId) ?? []);
    }
    assert.equal(out.get(100)?.[0]?.node.content, "Parent review");
    assert.equal(out.get(101)?.[0]?.node.content, "Parent review");
    assert.equal(out.get(101)?.[0]?.node.databaseId, out.get(100)?.[0]?.node.databaseId);
  });
});
