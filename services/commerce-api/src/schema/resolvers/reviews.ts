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
};
