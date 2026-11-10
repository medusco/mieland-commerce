import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupRepliesByParent,
  paginateProductReviewEdges,
  parseReviewCursor,
  reviewCursor,
  shapeCommentNode,
  shapeProductReviewEdge,
  type ProductReviewEdge,
  type ReviewCommentRow,
} from "./reviews.js";
import { toGlobalId } from "../utils/index.js";

function edge(
  id: number,
  opts: {
    rating?: number;
    author?: string;
    content?: string;
    date?: string;
    parent?: number;
  } = {},
): ProductReviewEdge {
  return shapeProductReviewEdge({
    comment_ID: id,
    comment_post_ID: 100,
    comment_parent: opts.parent ?? 0,
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
      comment_parent: 0,
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
    assert.equal(shaped.node.parentDatabaseId, 0);
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
        comment_parent: 0,
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

  it("keeps only top-level reviews in edges (replies excluded from pagination)", () => {
    // Simulates getProductReviewsMany filtering comment_parent = 0.
    const topLevel = [edge(30), edge(20)].filter(
      (e) => e.node.parentDatabaseId === 0,
    );
    const withReplyMixed = [
      edge(30),
      edge(31, { parent: 30, content: "should not be an edge" }),
      edge(20),
    ].filter((e) => e.node.parentDatabaseId === 0);

    assert.deepEqual(
      paginateProductReviewEdges(topLevel, { first: 10 }).edges.map(
        (e) => e.node.databaseId,
      ),
      [30, 20],
    );
    assert.deepEqual(
      paginateProductReviewEdges(withReplyMixed, { first: 10 }).edges.map(
        (e) => e.node.databaseId,
      ),
      [30, 20],
    );
  });
});

describe("variation review inheritance", () => {
  it("maps variation ids onto parent review lists", () => {
    const bySource = new Map<number, ProductReviewEdge[]>([
      [100, [edge(1, { content: "Parent review" })]],
    ]);
    const sourceById = new Map<number, number>([
      [100, 100],
      [101, 100],
    ]);
    const out = new Map<number, ProductReviewEdge[]>();
    for (const id of [100, 101]) {
      const sourceId = sourceById.get(id) ?? id;
      out.set(id, bySource.get(sourceId) ?? []);
    }
    assert.equal(out.get(100)?.[0]?.node.content, "Parent review");
    assert.equal(out.get(101)?.[0]?.node.content, "Parent review");
    assert.equal(
      out.get(101)?.[0]?.node.databaseId,
      out.get(100)?.[0]?.node.databaseId,
    );
  });
});

describe("groupRepliesByParent / Comment.replies", () => {
  it("groups approved replies oldest-first and supports nesting", () => {
    const rows: ReviewCommentRow[] = [
      {
        comment_ID: 12,
        comment_post_ID: 7,
        comment_parent: 10,
        comment_author: "Store",
        comment_date: "2024-03-11 10:00:00",
        comment_date_gmt: "2024-03-11 10:00:00",
        comment_content: "Thanks!",
        comment_karma: 0,
      },
      {
        comment_ID: 11,
        comment_post_ID: 7,
        comment_parent: 10,
        comment_author: "Store",
        comment_date: "2024-03-10 10:00:00",
        comment_date_gmt: "2024-03-10 10:00:00",
        comment_content: "First reply",
        comment_karma: 0,
      },
      {
        comment_ID: 13,
        comment_post_ID: 7,
        comment_parent: 12,
        comment_author: "Alex",
        comment_date: "2024-03-12 10:00:00",
        comment_date_gmt: "2024-03-12 10:00:00",
        comment_content: "Nested follow-up",
        comment_karma: 0,
      },
      {
        comment_ID: 99,
        comment_post_ID: 7,
        comment_parent: 0,
        comment_author: "Top",
        comment_date: "2024-03-01 10:00:00",
        comment_date_gmt: "2024-03-01 10:00:00",
        comment_content: "Ignored top-level",
        comment_karma: 0,
      },
    ];

    // Caller orders ASC before grouping; groupRepliesByParent preserves input order.
    const ordered = [...rows].sort((a, b) => {
      const da = String(a.comment_date_gmt);
      const db = String(b.comment_date_gmt);
      if (da !== db) return da < db ? -1 : 1;
      return Number(a.comment_ID) - Number(b.comment_ID);
    });
    const byParent = groupRepliesByParent(ordered);

    assert.deepEqual(
      (byParent.get(10) ?? []).map((n) => n.databaseId),
      [11, 12],
    );
    assert.equal(byParent.get(10)?.[0]?.content, "First reply");
    assert.equal(byParent.get(10)?.[0]?.parentDatabaseId, 10);
    assert.deepEqual(
      (byParent.get(12) ?? []).map((n) => n.databaseId),
      [13],
    );
    assert.equal(byParent.get(12)?.[0]?.content, "Nested follow-up");
    assert.equal(byParent.has(0), false);
    assert.equal(byParent.has(99), false);
  });

  it("shapeCommentNode never includes author email", () => {
    const node = shapeCommentNode({
      comment_ID: 5,
      comment_post_ID: 1,
      comment_parent: 2,
      comment_author: "Owner",
      comment_date: "2024-01-01 00:00:00",
      comment_date_gmt: "2024-01-01 00:00:00",
      comment_content: "Reply",
      comment_karma: 0,
    });
    assert.equal(node.parentDatabaseId, 2);
    assert.deepEqual(Object.keys(node.author.node), ["name"]);
  });
});
