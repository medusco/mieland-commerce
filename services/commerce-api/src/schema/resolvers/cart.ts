import type { GraphQLResolveInfo } from "graphql";
import type { AppContext } from "../../context.js";
import {
  findMergeableItem,
  loadCart,
  makeCartItemKey,
  mutateCart,
  saveCart,
} from "../../engine/cart-store.js";
import {
  parseExtraDataString,
  type CartAddress,
  type CartState,
} from "../../engine/types.js";
import { withCartSubscriptionDisplayPrices, type PricedProductNode } from "../../engine/pricing.js";
import {
  assertInStock,
  calculateCart,
  emptyTaxBreakdown,
  type CalculatedCart,
  type CartTotalsMode,
} from "../../engine/totals.js";
import { loadCoupon, assertCouponApplicable } from "../../engine/shipping.js";
import {
  cartNeedsFromInfo,
  cartNeedsPricing,
  type CartFieldNeeds,
} from "../../utils/selection.js";

function mapAddressInput(
  input?: CartAddress | null,
): CartAddress {
  if (!input) return {};
  const out: CartAddress = {};
  const keys = [
    "firstName",
    "lastName",
    "company",
    "address1",
    "address2",
    "city",
    "state",
    "postcode",
    "country",
    "phone",
    "email",
  ] as const;
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

async function shapeCartGraphql(
  ctx: AppContext,
  cart: CartState,
  mode: CartTotalsMode,
  needs: CartFieldNeeds,
  preCalculated?: CalculatedCart | null,
) {
  const calculated =
    preCalculated ??
    (await calculateCart(cart, mode, {
      pricing: cartNeedsPricing(needs),
      userId: ctx.userId,
      calculateTax: mode === "full" && needs.cartTotals,
    }));
  if (
    !preCalculated &&
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

  const pricing = cartNeedsPricing(needs);
  const hasPercentCoupon = calculated.appliedCoupons.some(
    (coupon) => coupon.discountType === "percent",
  );
  const nodes = calculated.lines.map((line) => {
    const productRaw = needs.products
      ? (productById.get(line.productId) as PricedProductNode | undefined)
      : null;
    const variationRaw =
      needs.variations && line.variationId
        ? (productById.get(line.variationId) as PricedProductNode | undefined)
        : null;
    const displayOpts = { forceSalePrice: hasPercentCoupon };
    const product =
      productRaw && pricing
        ? withCartSubscriptionDisplayPrices(
            productRaw,
            line.displayUnitPrice,
            displayOpts,
          )
        : productRaw;
    const variation =
      variationRaw && pricing
        ? withCartSubscriptionDisplayPrices(
            variationRaw,
            line.displayUnitPrice,
            displayOpts,
          )
        : variationRaw;
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
    taxSuccess: needs.cartTotals
      ? (calculated.taxBreakdown?.success ?? null)
      : null,
    taxMessage: needs.cartTotals
      ? (calculated.taxBreakdown?.message ?? null)
      : null,
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
    freeShippingInfo: needs.shippingMethods
      ? calculated.freeShippingInfo
      : null,
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
      _args: { recalculateTotals?: boolean; calculateShippingTax?: boolean },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const cart = await loadCart(ctx.sessionToken);
      return shapeCartGraphql(
        ctx,
        cart,
        "full",
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
      assertCouponApplicable(coupon);
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

    calculateCartTax: async (
      _: unknown,
      {
        input,
      }: {
        input?: {
          clientMutationId?: string;
          address?: CartAddress | null;
          shippingCost?: string | null;
          shippingMethodId?: string | null;
        } | null;
      },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const addressIn = mapAddressInput(input?.address);
      const hasAddressOverride = Object.keys(addressIn).length > 0;

      let cart = await loadCart(ctx.sessionToken);
      if (!cart.items.length) throw new Error("Cart is empty");

      if (hasAddressOverride) {
        cart = await mutateCart(ctx.sessionToken, async (c) => {
          c.shipping = { ...c.shipping, ...addressIn };
          if (!c.billing.address1) {
            const { email: _e, ...asBilling } = addressIn;
            c.billing = { ...c.billing, ...asBilling };
          }
          if (ctx.userId) c.customerId = ctx.userId;
          return { cart: c, result: c };
        });
      }

      const shippingCostRaw = input?.shippingCost;
      const taxShippingCost =
        shippingCostRaw != null && shippingCostRaw !== ""
          ? Number(shippingCostRaw)
          : null;
      const taxShippingMethodId = input?.shippingMethodId?.trim() || null;

      const calculated = await calculateCart(cart, "full", {
        userId: ctx.userId,
        calculateTax: true,
        taxAddress: hasAddressOverride ? addressIn : null,
        taxShippingCost:
          taxShippingCost != null && Number.isFinite(taxShippingCost)
            ? taxShippingCost
            : null,
        taxShippingMethodId,
      });

      if (
        JSON.stringify(calculated.chosenShippingMethods) !==
        JSON.stringify(cart.chosenShippingMethods)
      ) {
        await saveCart(ctx.sessionToken, calculated.cart);
        cart = calculated.cart;
      }

      const tax =
        calculated.taxBreakdown ??
        emptyTaxBreakdown({
          message: "Tax was not calculated",
          subtotal: calculated.subtotal,
          shippingTotal: calculated.shippingTotal,
          total: calculated.total,
        });

      return {
        clientMutationId: input?.clientMutationId ?? null,
        tax,
        cart: await shapeCartGraphql(
          ctx,
          cart,
          "full",
          cartNeedsFromInfo(info, "payload"),
          calculated,
        ),
      };
    },
  },
};

export { shapeCartGraphql };
