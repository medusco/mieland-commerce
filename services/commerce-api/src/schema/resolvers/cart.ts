import type { GraphQLResolveInfo } from "graphql";
import type { AppContext } from "../../context.js";
import {
  findMergeableItem,
  loadCart,
  makeCartItemKey,
  mutateCart,
  saveCart,
} from "../../engine/cart-store.js";
import { parseExtraDataString, type CartState } from "../../engine/types.js";
import { assertInStock, calculateCart, type CartTotalsMode } from "../../engine/totals.js";
import { loadCoupon } from "../../engine/shipping.js";
import {
  cartNeedsFromInfo,
  cartNeedsPricing,
  type CartFieldNeeds,
} from "../../utils/selection.js";

async function shapeCartGraphql(
  ctx: AppContext,
  cart: CartState,
  mode: CartTotalsMode,
  needs: CartFieldNeeds,
) {
  const calculated = await calculateCart(cart, mode, {
    pricing: cartNeedsPricing(needs),
  });
  if (
    needs.shippingMethods &&
    mode === "full" &&
    JSON.stringify(calculated.chosenShippingMethods) !==
      JSON.stringify(cart.chosenShippingMethods)
  ) {
    await saveCart(ctx.sessionToken, calculated.cart);
  }

  const loadProducts = needs.products || needs.variations;
  const productIds = loadProducts
    ? [
        ...new Set(
          calculated.lines.flatMap((line) => {
            const ids = [line.productId];
            if (needs.variations && line.variationId) ids.push(line.variationId);
            return ids;
          }),
        ),
      ]
    : [];
  const productNodes = loadProducts
    ? await ctx.productLoader.loadMany(productIds)
    : [];
  const productById = new Map<number, unknown>();
  for (let i = 0; i < productIds.length; i++) {
    const node = productNodes[i];
    if (node && !(node instanceof Error)) productById.set(productIds[i], node);
  }

  const nodes = calculated.lines.map((line) => {
    const product = needs.products ? productById.get(line.productId) : null;
    const variation =
      needs.variations && line.variationId
        ? productById.get(line.variationId)
        : null;
    return {
      key: line.key,
      quantity: line.quantity,
      subtotal: needs.lineSubtotal ? line.subtotal : null,
      extraData: needs.lineExtraData ? line.extraData : null,
      product: product ? { node: product } : null,
      variation: variation ? { node: variation } : null,
    };
  });

  return {
    total: needs.cartTotals ? calculated.total : null,
    subtotal: needs.cartTotals ? calculated.subtotal : null,
    shippingTotal: needs.cartTotals ? calculated.shippingTotal : null,
    totalTax: needs.cartTotals ? calculated.totalTax : null,
    appliedCoupons: needs.coupons ? calculated.appliedCoupons : [],
    contents: {
      itemCount: calculated.itemCount,
      nodes,
    },
    availableShippingMethods: needs.shippingMethods
      ? calculated.availableShippingMethods
      : [],
    chosenShippingMethods: needs.shippingMethods
      ? calculated.chosenShippingMethods
      : [],
  };
}

function modeFromArgs(
  args: { calculateShippingTax?: boolean; recalculateTotals?: boolean },
  forceFull = false,
): CartTotalsMode {
  if (forceFull) return "full";
  if (args.calculateShippingTax || args.recalculateTotals) return "full";
  return "lightweight";
}

/** Full totals when coupons are applied so discount/shipping refresh after item changes. */
function modeForCart(
  cart: CartState,
  args: { calculateShippingTax?: boolean; recalculateTotals?: boolean },
  forceFull = false,
): CartTotalsMode {
  return modeFromArgs(args, forceFull || cart.coupons.length > 0);
}

export const cartResolvers = {
  Query: {
    cart: async (
      _: unknown,
      args: { recalculateTotals?: boolean; calculateShippingTax?: boolean },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const cart = await loadCart(ctx.sessionToken);
      const mode = modeFromArgs(args);
      const hasAddress = Boolean(cart.shipping.country || cart.billing.country);
      return shapeCartGraphql(
        ctx,
        cart,
        mode === "full" || hasAddress ? "full" : "lightweight",
        cartNeedsFromInfo(info, "root"),
      );
    },
  },
  Mutation: {
    addToCart: async (
      _: unknown,
      { input }: { input: {
        productId: number;
        quantity?: number;
        variationId?: number;
        extraData?: string;
        calculateShippingTax?: boolean;
        clientMutationId?: string;
      } },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const qty = input.quantity ?? 1;
      const extra = parseExtraDataString(input.extraData);

      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        const existing = findMergeableItem(
          c,
          input.productId,
          input.variationId ?? null,
          extra,
        );
        const totalQty = (existing?.quantity ?? 0) + qty;
        await assertInStock(input.productId, input.variationId ?? null, totalQty);
        if (existing) {
          existing.quantity = totalQty;
          if (extra.length) existing.extraData = extra;
        } else {
          c.items.push({
            key: makeCartItemKey(input.productId, input.variationId ?? null, extra),
            productId: input.productId,
            variationId: input.variationId ?? null,
            quantity: qty,
            extraData: extra,
          });
        }
        return { cart: c, result: c };
      });

      const mode = modeForCart(cart, input);
      return {
        clientMutationId: input.clientMutationId,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          mode,
          cartNeedsFromInfo(info, "payload"),
        ),
      };
    },

    removeItemsFromCart: async (
      _: unknown,
      { input }: { input: { keys?: string[]; calculateShippingTax?: boolean; clientMutationId?: string } },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const keys = new Set((input.keys ?? []).map(String));
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        c.items = c.items.filter((i) => !keys.has(String(i.key)));
        return { cart: c, result: c };
      });
      return {
        clientMutationId: input.clientMutationId,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          modeForCart(cart, input),
          cartNeedsFromInfo(info, "payload"),
        ),
      };
    },

    updateItemQuantities: async (
      _: unknown,
      { input }: {
        input: {
          items?: Array<{ key: string; quantity: number; extraData?: string }>;
          calculateShippingTax?: boolean;
          clientMutationId?: string;
        };
      },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        for (const upd of input.items ?? []) {
          const item = c.items.find((i) => String(i.key) === String(upd.key));
          if (!item) continue;
          if (upd.quantity <= 0) {
            c.items = c.items.filter((i) => i.key !== item.key);
            continue;
          }
          await assertInStock(item.productId, item.variationId, upd.quantity);
          item.quantity = upd.quantity;
          if (upd.extraData !== undefined) {
            item.extraData = parseExtraDataString(upd.extraData);
          }
        }
        return { cart: c, result: c };
      });
      return {
        clientMutationId: input.clientMutationId,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          modeForCart(cart, input),
          cartNeedsFromInfo(info, "payload"),
        ),
      };
    },

    updateShippingMethod: async (
      _: unknown,
      { input }: { input: { shippingMethods?: string[]; clientMutationId?: string } },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        c.chosenShippingMethods = (input.shippingMethods ?? []).filter(Boolean);
        return { cart: c, result: c };
      });
      return {
        clientMutationId: input.clientMutationId,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          "full",
          cartNeedsFromInfo(info, "payload"),
        ),
      };
    },

    applyCoupon: async (
      _: unknown,
      { input }: { input: { code: string; calculateShippingTax?: boolean; clientMutationId?: string } },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const code = input.code.trim();
      const coupon = await loadCoupon(code);
      if (!coupon) throw new Error("Invalid coupon code");
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        if (!c.coupons.includes(code)) c.coupons.push(code);
        return { cart: c, result: c };
      });
      return {
        clientMutationId: input.clientMutationId,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          modeFromArgs(input, true),
          cartNeedsFromInfo(info, "payload"),
        ),
      };
    },

    removeCoupons: async (
      _: unknown,
      { input }: { input: { codes?: string[]; calculateShippingTax?: boolean; clientMutationId?: string } },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const codes = new Set((input.codes ?? []).map((c) => c.toLowerCase()));
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        c.coupons = c.coupons.filter((c) => !codes.has(c.toLowerCase()));
        return { cart: c, result: c };
      });
      return {
        clientMutationId: input.clientMutationId,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          modeFromArgs(input, true),
          cartNeedsFromInfo(info, "payload"),
        ),
      };
    },
  },
};

export { shapeCartGraphql };
