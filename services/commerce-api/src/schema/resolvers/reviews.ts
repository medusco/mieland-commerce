import type { AppContext } from "../../context.js";
import { requireUser } from "../../context.js";
import {
  writeProductReview,
  type WriteReviewInput,
} from "../../repositories/reviews.js";

export const reviewResolvers = {
  Mutation: {
    writeReview: async (
      _: unknown,
      { input }: { input: WriteReviewInput },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      return writeProductReview(userId, input);
    },
  },
  Comment: {
    parentDatabaseId: (parent: { parentDatabaseId?: number | null }) =>
      parent.parentDatabaseId ?? 0,
    replies: async (
      parent: { databaseId?: number | null },
      _args: unknown,
      ctx: AppContext,
    ) => {
      const id = parent.databaseId;
      if (!id) return { nodes: [] };
      const nodes = await ctx.commentRepliesLoader.load(id);
      return { nodes };
    },
  },
};
