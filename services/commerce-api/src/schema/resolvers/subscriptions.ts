import type { AppContext } from "../../context.js";
import { requireUser } from "../../context.js";
import {
  cancelSubscription,
  getSubscription,
  getSubscriptionSettings,
  listSubscriptions,
  updateSubscription,
} from "../../repositories/subscriptions.js";

export const subscriptionResolvers = {
  Query: {
    mielandSubscriptionSettings: async () => getSubscriptionSettings(),
    mielandSubscriptions: async (
      _: unknown,
      args: { status?: string },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      return listSubscriptions(userId, args.status);
    },
    mielandSubscription: async (
      _: unknown,
      args: { id: number },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      return getSubscription(args.id, userId);
    },
  },
  Mutation: {
    updateMielandSubscription: async (
      _: unknown,
      { input }: {
        input: {
          id: number;
          frequency?: string;
          quantity?: number;
          clientMutationId?: string;
        };
      },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      const subscription = await updateSubscription(input.id, userId, {
        frequency: input.frequency,
        quantity: input.quantity,
      });
      return { clientMutationId: input.clientMutationId, subscription };
    },
    cancelMielandSubscription: async (
      _: unknown,
      { input }: { input: { id: number; clientMutationId?: string } },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      const subscription = await cancelSubscription(input.id, userId);
      return { clientMutationId: input.clientMutationId, subscription };
    },
  },
};
