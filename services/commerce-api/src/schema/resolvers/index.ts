import { cartResolvers } from "./cart.js";
import { productResolvers } from "./products.js";
import { customerResolvers } from "./customer.js";
import { subscriptionResolvers } from "./subscriptions.js";
import { contentResolvers } from "./content.js";
import { checkoutResolvers } from "./checkout.js";

function mergeResolvers(
  ...maps: Array<Record<string, Record<string, unknown>>>
) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const map of maps) {
    for (const [type, fields] of Object.entries(map)) {
      out[type] = { ...(out[type] ?? {}), ...fields };
    }
  }
  return out;
}

export const resolvers = mergeResolvers(
  cartResolvers,
  productResolvers,
  customerResolvers,
  subscriptionResolvers,
  contentResolvers,
  checkoutResolvers,
);
