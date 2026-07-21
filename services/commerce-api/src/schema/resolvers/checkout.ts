import { createHash } from "node:crypto";
import type { AppContext } from "../../context.js";
import { requireUser } from "../../context.js";
import { clearCart, loadCart, mutateCart, saveCart } from "../../engine/cart-store.js";
import { calculateCart } from "../../engine/totals.js";
import {
  buildWcOrderFromCart,
  createWcOrder,
} from "../../clients/woocommerce-rest.js";
import { getCustomer } from "../../repositories/customers.js";
import { getOrderById, shapeOrder } from "../../repositories/orders.js";
import { getRedis } from "../../redis/client.js";
import { logJson, parseDatabaseId } from "../../utils/index.js";
import type { CartAddress } from "../../engine/types.js";

function mapAddress(input?: CartAddress | null): CartAddress {
  if (!input) return {};
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    company: input.company,
    address1: input.address1,
    address2: input.address2,
    city: input.city,
    state: input.state,
    postcode: input.postcode,
    country: input.country,
    phone: input.phone,
    email: input.email,
  };
}

async function withCheckoutIdempotency<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const redis = getRedis();
  const existing = await redis.get(`checkout:idemp:${key}`);
  if (existing) {
    return JSON.parse(existing) as T;
  }
  const result = await fn();
  await redis.set(
    `checkout:idemp:${key}`,
    JSON.stringify(result),
    "EX",
    60 * 60,
  );
  return result;
}

export const checkoutResolvers = {
  Mutation: {
    createOrder: async (
      _: unknown,
      { input }: { input: { customerId: number; clientMutationId?: string } },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      if (input.customerId !== userId) {
        throw new Error("customerId does not match authenticated user");
      }
      const cart = await loadCart(ctx.sessionToken);
      if (!cart.items.length) throw new Error("Cart is empty");
      const calculated = await calculateCart(cart, "full");
      await saveCart(ctx.sessionToken, calculated.cart);

      const idempKey = createHash("sha256")
        .update(`${ctx.sessionToken}:${JSON.stringify(cart.items)}:create`)
        .digest("hex");

      const payload = await withCheckoutIdempotency(idempKey, async () => {
        const wcPayload = buildWcOrderFromCart({
          cart: calculated.cart,
          calculated,
          paymentMethod: "stripe",
          customerId: userId,
        });
        const started = Date.now();
        const wcOrder = await createWcOrder(wcPayload);
        logJson("info", {
          msg: "create_order_ok",
          requestId: ctx.requestId,
          ms: Date.now() - started,
          orderId: wcOrder.id,
        });
        return wcOrder;
      });

      await clearCart(ctx.sessionToken);
      const orderId = Number(payload.id);
      const order = (await shapeOrder(orderId)) ?? (await getOrderById(orderId, userId));
      return {
        clientMutationId: input.clientMutationId,
        orderId,
        order,
      };
    },

    checkout: async (
      _: unknown,
      { input }: {
        input: {
          paymentMethod?: string;
          metaData?: Array<{ key: string; value?: string | null }>;
          customerNote?: string;
          billing?: CartAddress;
          shipping?: CartAddress;
          shipToDifferentAddress?: boolean;
          clientMutationId?: string;
        };
      },
      ctx: AppContext,
    ) => {
      const userId = ctx.userId; // guest checkout allowed but Stripe meta usually needs account
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        if (input.billing) c.billing = { ...c.billing, ...mapAddress(input.billing) };
        if (input.shipping) c.shipping = { ...c.shipping, ...mapAddress(input.shipping) };
        if (input.shipToDifferentAddress === false && input.billing) {
          c.shipping = { ...c.shipping, ...mapAddress(input.billing) };
        }
        if (userId) c.customerId = userId;
        return { cart: c, result: c };
      });

      if (!cart.items.length) throw new Error("Cart is empty");
      const calculated = await calculateCart(cart, "full");
      await saveCart(ctx.sessionToken, calculated.cart);

      const meta = (input.metaData ?? [])
        .filter((m) => m.key)
        .map((m) => ({ key: m.key, value: String(m.value ?? "") }));

      const idempKey = createHash("sha256")
        .update(
          `${ctx.sessionToken}:${JSON.stringify(cart.items)}:${JSON.stringify(meta)}:checkout`,
        )
        .digest("hex");

      const wcOrder = await withCheckoutIdempotency(idempKey, async () => {
        const wcPayload = buildWcOrderFromCart({
          cart: calculated.cart,
          calculated,
          paymentMethod: input.paymentMethod || "stripe",
          customerNote: input.customerNote,
          metaData: meta,
          customerId: userId,
        });
        const started = Date.now();
        try {
          const order = await createWcOrder(wcPayload);
          logJson("info", {
            msg: "checkout_ok",
            requestId: ctx.requestId,
            ms: Date.now() - started,
            orderId: order.id,
          });
          return order;
        } catch (err) {
          logJson("error", {
            msg: "checkout_fail",
            requestId: ctx.requestId,
            ms: Date.now() - started,
            err: String(err),
          });
          throw err;
        }
      });

      await clearCart(ctx.sessionToken);
      const orderId = Number(wcOrder.id);
      const order = await shapeOrder(orderId);
      const customer = userId
        ? await getCustomer(userId, ctx.sessionToken)
        : {
            databaseId: null,
            email: cart.billing.email ?? null,
          };

      return {
        clientMutationId: input.clientMutationId,
        customer,
        order,
        redirect: null,
        result: "success",
      };
    },
  },
};

void parseDatabaseId;
