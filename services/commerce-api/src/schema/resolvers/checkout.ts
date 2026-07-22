import { createHash } from "node:crypto";
import type { GraphQLResolveInfo } from "graphql";
import type { AppContext } from "../../context.js";
import { requireUser } from "../../context.js";
import { clearCart, loadCart, mutateCart, saveCart } from "../../engine/cart-store.js";
import { assertInStock, calculateCart } from "../../engine/totals.js";
import {
  buildWcOrderFromCart,
  createWcOrder,
} from "../../clients/woocommerce-rest.js";
import {
  processStoreCheckoutOrder,
  toStorePaymentData,
  type StoreAddress,
} from "../../clients/woocommerce-store.js";
import { getCustomer } from "../../repositories/customers.js";
import {
  getOrderById,
  getOrderPaymentContext,
  shapeOrder,
  shapeOrderFromWc,
} from "../../repositories/orders.js";
import { getRedis } from "../../redis/client.js";
import { logJson, parseDatabaseId } from "../../utils/index.js";
import {
  orderNeedsAreLean,
  orderNeedsFromInfo,
} from "../../utils/selection.js";
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

function toStoreAddress(
  a: {
    firstName?: string | null;
    lastName?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    state?: string | null;
    postcode?: string | null;
    country?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null | undefined,
  opts?: { includeEmail?: boolean },
): StoreAddress {
  const base: StoreAddress = {
    first_name: a?.firstName ?? "",
    last_name: a?.lastName ?? "",
    company: a?.company ?? "",
    address_1: a?.address1 ?? "",
    address_2: a?.address2 ?? "",
    city: a?.city ?? "",
    state: a?.state ?? "",
    postcode: a?.postcode ?? "",
    country: a?.country ?? "",
    phone: a?.phone ?? "",
  };
  if (opts?.includeEmail !== false) {
    base.email = a?.email ?? "";
  }
  return base;
}

function wantsCustomer(info: GraphQLResolveInfo): boolean {
  const fields = info.fieldNodes.flatMap(
    (n) => n.selectionSet?.selections ?? [],
  );
  return fields.some(
    (s) => s.kind === "Field" && s.name.value === "customer",
  );
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

async function assertCartInStock(
  items: Array<{ productId: number; variationId: number | null; quantity: number }>,
) {
  for (const item of items) {
    await assertInStock(item.productId, item.variationId, item.quantity);
  }
}

export const checkoutResolvers = {
  Mutation: {
    createOrder: async (
      _: unknown,
      { input }: { input: { customerId: number; clientMutationId?: string } },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const userId = requireUser(ctx);
      if (input.customerId !== userId) {
        throw new Error("customerId does not match authenticated user");
      }
      const cart = await loadCart(ctx.sessionToken);
      if (!cart.items.length) throw new Error("Cart is empty");
      await assertCartInStock(cart.items);

      // WC prices line items; we only need totals for shipping_lines / coupons.
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
      const needs = orderNeedsFromInfo(info, ["order"]);
      const order = orderNeedsAreLean(needs)
        ? shapeOrderFromWc(payload)
        : ((await shapeOrder(orderId, needs)) ??
          (await getOrderById(orderId, userId)));
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
      info: GraphQLResolveInfo,
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
      await assertCartInStock(cart.items);

      // Line item prices are not sent to WC — it recalculates from catalog.
      // calculateCart is still needed for shipping_lines / free-shipping thresholds.
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
      const needs = orderNeedsFromInfo(info, ["order"]);
      const shapeStarted = Date.now();
      const order = orderNeedsAreLean(needs)
        ? shapeOrderFromWc(wcOrder)
        : await shapeOrder(orderId, needs);
      logJson("info", {
        msg: "checkout_shape_order",
        requestId: ctx.requestId,
        ms: Date.now() - shapeStarted,
        lean: orderNeedsAreLean(needs),
        orderId,
      });

      const customer = wantsCustomer(info)
        ? userId
          ? await getCustomer(userId, ctx.sessionToken)
          : {
              databaseId: null,
              email: cart.billing.email ?? null,
            }
        : null;

      return {
        clientMutationId: input.clientMutationId,
        customer,
        order,
        redirect: null,
        result: "success",
      };
    },

    processOrderPayment: async (
      _: unknown,
      {
        input,
      }: {
        input: {
          clientMutationId?: string;
          orderId: number;
          orderKey?: string | null;
          billingEmail?: string | null;
          paymentMethod?: string | null;
          paymentData?: Array<{ key: string; value?: string | null }>;
        };
      },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const orderId = Number(input.orderId);
      if (!Number.isFinite(orderId) || orderId <= 0) {
        throw new Error("Invalid orderId");
      }

      const ctxOrder = await getOrderPaymentContext(orderId);
      if (!ctxOrder) throw new Error("Order not found");

      if (ctx.userId != null) {
        if (ctxOrder.customerId > 0 && ctxOrder.customerId !== ctx.userId) {
          throw new Error("Order not found");
        }
      } else if (ctxOrder.customerId > 0) {
        throw new Error("Authentication required");
      }

      if (!ctxOrder.needsPayment) {
        throw new Error(`Order does not need payment (status: ${ctxOrder.status})`);
      }

      const orderKey = (input.orderKey || ctxOrder.orderKey || "").trim();
      if (!orderKey) {
        throw new Error("orderKey is required");
      }
      if (ctxOrder.orderKey && input.orderKey && input.orderKey !== ctxOrder.orderKey) {
        throw new Error("Invalid orderKey");
      }

      const billingEmail =
        input.billingEmail || ctxOrder.billing?.email || undefined;
      if (ctxOrder.customerId === 0 && !billingEmail) {
        throw new Error("billingEmail is required for guest orders");
      }

      const paymentMethod =
        input.paymentMethod || ctxOrder.paymentMethod || "stripe";
      const paymentData = toStorePaymentData(input.paymentData);

      // Stripe Store API usually expects billing fields inside payment_data too.
      if (paymentMethod === "stripe") {
        const billing = ctxOrder.billing;
        if (billingEmail && !paymentData.some((p) => p.key === "billing_email")) {
          paymentData.push({ key: "billing_email", value: billingEmail });
        }
        if (
          billing?.firstName &&
          !paymentData.some((p) => p.key === "billing_first_name")
        ) {
          paymentData.push({
            key: "billing_first_name",
            value: billing.firstName,
          });
        }
        if (
          billing?.lastName &&
          !paymentData.some((p) => p.key === "billing_last_name")
        ) {
          paymentData.push({
            key: "billing_last_name",
            value: billing.lastName,
          });
        }
        if (!paymentData.some((p) => p.key === "paymentMethod")) {
          paymentData.push({ key: "paymentMethod", value: "stripe" });
        }
      }

      const started = Date.now();
      let storeRes;
      try {
        storeRes = await processStoreCheckoutOrder(orderId, {
          key: orderKey,
          billing_email: billingEmail,
          billing_address: toStoreAddress(ctxOrder.billing),
          shipping_address: toStoreAddress(ctxOrder.shipping, {
            includeEmail: false,
          }),
          payment_method: paymentMethod,
          payment_data: paymentData,
        });
        logJson("info", {
          msg: "process_order_payment_ok",
          requestId: ctx.requestId,
          ms: Date.now() - started,
          orderId,
          paymentStatus: storeRes.payment_result?.payment_status,
        });
      } catch (err) {
        logJson("error", {
          msg: "process_order_payment_fail",
          requestId: ctx.requestId,
          ms: Date.now() - started,
          orderId,
          err: String(err),
        });
        throw err;
      }

      const paymentResult = storeRes.payment_result;
      const needs = orderNeedsFromInfo(info, ["order"]);
      const order =
        (await shapeOrder(orderId, needs)) ??
        (await getOrderById(orderId, ctx.userId));

      return {
        clientMutationId: input.clientMutationId,
        order,
        result: paymentResult?.payment_status ?? "unknown",
        redirect: paymentResult?.redirect_url || null,
        paymentStatus: paymentResult?.payment_status ?? null,
        paymentDetails: (paymentResult?.payment_details ?? []).map((d) => ({
          key: d.key,
          value: String(d.value ?? ""),
        })),
      };
    },
  },
};

void parseDatabaseId;
