import { createHash } from "node:crypto";
import { GraphQLError } from "graphql";
import type { GraphQLResolveInfo } from "graphql";
import type { AppContext } from "../../context.js";
import { FORCE_LOGOUT_CODE, requireUser, scheduleForceLogout } from "../../context.js";
import { clearCart, loadCart, mutateCart, saveCart } from "../../engine/cart-store.js";
import {
  assertInStock,
  assertCheckoutTaxCalculated,
  calculateCart,
  emptyTaxBreakdown,
} from "../../engine/totals.js";
import {
  buildWcOrderFromCart,
  createWcOrder,
  updateWcOrder,
} from "../../clients/woocommerce-rest.js";
import { createPaypalOrder, capturePaypalOrder } from "../../clients/paypal.js";
import {
  createPaymentIntent,
  getStripePublishableKey,
} from "../../clients/stripe.js";
import { getPaypalPublicSettings } from "../../repositories/paypal.js";
import {
  inspectWpCookieEncoding,
  isWpSessionAliveForUser,
  isWpSessionMatchingUser,
  normalizeWpCookieHeader,
  parseWpLoggedInUserLogin,
} from "../../auth/wp-session.js";
import { refreshWpSessionFromCookie } from "../../auth/wp-refresh.js";
import { findUserById } from "../../auth/index.js";
import { getCustomer } from "../../repositories/customers.js";
import {
  assertCouponApplicable,
  assertCouponEmailAllowed,
  loadCoupon,
  normalizeApplicantEmails,
} from "../../engine/shipping.js";
import {
  assertCouponNotHeldByUnpaidOrder,
  assertCouponNotRedeemedOnPaidOrder,
  assertCouponUsageLimitLikeWoo,
} from "../../repositories/coupon-holds.js";
import {
  getOrderById,
  getOrderPaymentContext,
  shapeOrder,
  shapeOrderFromWc,
} from "../../repositories/orders.js";
import { getRedis } from "../../redis/client.js";
import { logJson, parseDatabaseId } from "../../utils/index.js";
import {
  logPaymentTrace,
  paymentAuthSnapshot,
  summarizePaymentData,
  wpSessionEncodingSnapshot,
} from "../../utils/payment-trace.js";
import {
  orderNeedsAreLean,
  orderNeedsFromInfo,
} from "../../utils/selection.js";
import type { CartAddress } from "../../engine/types.js";

const FORCE_LOGOUT_MESSAGE =
  "You have been signed out. Please sign in again to continue.";

const PPCP_GATEWAY = "ppcp-gateway";

function isPaypalPaymentMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").trim().toLowerCase();
  return m === PPCP_GATEWAY || m === "paypal" || m.startsWith("ppcp-");
}

function isStripePaymentMethod(method: string | null | undefined): boolean {
  const m = (method ?? "").trim().toLowerCase();
  return !m || m === "stripe" || m.startsWith("stripe");
}

/** Ensure mc-wp-session matches JWT; refresh via stored WP token when stale. */
async function requireSyncedWpSession(ctx: AppContext): Promise<string> {
  const userId = ctx.userId;
  if (userId == null) {
    throw new Error("Authentication required");
  }

  const origin =
    ctx.req.headers.get("origin") || ctx.req.headers.get("Origin") || null;
  const refreshOpts = {
    requestScopeId: ctx.requestScopeId,
    req: ctx.req,
    origin,
    wpRefreshToken: ctx.wpRefreshToken,
  };
  const wpCookie =
    normalizeWpCookieHeader(ctx.wpAuthCookie) || "";

  const acceptCookie = async (
    cookie: string,
    opts?: { trustAfterRefresh?: boolean },
  ): Promise<boolean> => {
    const normalized = normalizeWpCookieHeader(cookie) || "";
    if (!normalized) return false;
    if (!(await isWpSessionMatchingUser(normalized, userId))) return false;
    if (opts?.trustAfterRefresh) return true;
    return isWpSessionAliveForUser(normalized, userId, origin);
  };

  const logOk = (
    source: string,
    cookieHeader: string,
    rawHeader?: string | null,
  ) => {
    logPaymentTrace("info", {
      msg: "wp_session_sync_ok",
      requestId: ctx.requestId,
      jwtUserId: userId,
      source,
      wpLoggedInLogin: parseWpLoggedInUserLogin(cookieHeader),
      wpCookieHeader: cookieHeader,
      ...inspectWpCookieEncoding(cookieHeader),
      ...wpSessionEncodingSnapshot("incomingHeaderMcWpSession", rawHeader),
      ...paymentAuthSnapshot(ctx),
    });
  };

  // Fast path: use the browser mirror before a slow/failing WP refresh round-trip.
  if (wpCookie && (await acceptCookie(wpCookie))) {
    logOk(
      "context_cookie",
      wpCookie,
      ctx.req.headers.get("x-mc-wp-session"),
    );
    return wpCookie;
  }

  const refreshed = await refreshWpSessionFromCookie(refreshOpts);
  if (
    refreshed?.cookieHeader &&
    (await acceptCookie(refreshed.cookieHeader, { trustAfterRefresh: true }))
  ) {
    const cookieHeader =
      normalizeWpCookieHeader(refreshed.cookieHeader) ||
      refreshed.cookieHeader;
    logOk("refresh", cookieHeader, ctx.req.headers.get("x-mc-wp-session"));
    return cookieHeader;
  }

  // Refresh GraphQL often errors while wordpress_logged_in_* is still valid.
  if (wpCookie && (await isWpSessionMatchingUser(wpCookie, userId))) {
    logPaymentTrace("warn", {
      msg: "wp_session_sync_soft_accept",
      requestId: ctx.requestId,
      jwtUserId: userId,
      wpLoggedInLogin: parseWpLoggedInUserLogin(wpCookie),
      wpCookieHeader: wpCookie,
      refreshAttempted: Boolean(refreshed),
      ...inspectWpCookieEncoding(wpCookie),
      ...wpSessionEncodingSnapshot(
        "incomingHeaderMcWpSession",
        ctx.req.headers.get("x-mc-wp-session"),
      ),
      ...paymentAuthSnapshot(ctx),
    });
    return wpCookie;
  }

  if (refreshed?.cookieHeader) {
    const cookieHeader =
      normalizeWpCookieHeader(refreshed.cookieHeader) ||
      refreshed.cookieHeader;
    if (await isWpSessionMatchingUser(cookieHeader, userId)) {
      logOk(
        "refresh_soft",
        cookieHeader,
        ctx.req.headers.get("x-mc-wp-session"),
      );
      return cookieHeader;
    }
  }

  if (!wpCookie && !refreshed?.cookieHeader) {
    logPaymentTrace("error", {
      msg: "wp_session_sync_missing",
      requestId: ctx.requestId,
      jwtUserId: userId,
      ...paymentAuthSnapshot(ctx),
    });
    throw new Error(
      "WordPress session required — log in again (missing mc-wp-session cookie)",
    );
  }

  logPaymentTrace("error", {
    msg: "wp_session_sync_force_logout",
    requestId: ctx.requestId,
    jwtUserId: userId,
    wpCookieHeader: wpCookie || null,
    hadRefresh: Boolean(refreshed?.cookieHeader),
    ...paymentAuthSnapshot(ctx),
  });
  scheduleForceLogout(ctx.requestScopeId, ctx.req);
  throw new GraphQLError(FORCE_LOGOUT_MESSAGE, {
    extensions: { code: FORCE_LOGOUT_CODE },
  });
}

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


function isStripeWalletPayment(
  metaData?: Array<{ key: string; value?: string | null }> | null,
): boolean {
  if (!metaData?.length) return false;
  const upe = metaData.find(
    (m) =>
      m.key === "_stripe_upe_payment_type" ||
      m.key === "stripe_upe_payment_type" ||
      m.key === "upePaymentType",
  )?.value;
  const normalized = String(upe ?? "").toLowerCase();
  return (
    normalized === "google_pay" ||
    normalized === "apple_pay" ||
    normalized === "link"
  );
}

/**
 * Resolve billing/shipping for order create.
 * Express / wallet checkouts send the wallet-selected address on shipping (and
 * usually mirror it on billing). Prefer shipping when present so a stale cart
 * customer billing address cannot win. shipToDifferentAddress false copies
 * billing → shipping for regular card checkout.
 */
function resolveCheckoutAddresses(input: {
  billing?: CartAddress | null;
  shipping?: CartAddress | null;
  shipToDifferentAddress?: boolean | null;
  metaData?: Array<{ key: string; value?: string | null }> | null;
}): { billing: CartAddress; shipping: CartAddress } {
  const billingIn = mapAddress(input.billing);
  const shippingIn = mapAddress(input.shipping);
  const email = billingIn.email;
  const wallet = isStripeWalletPayment(input.metaData);
  const singleAddress = input.shipToDifferentAddress !== true;

  // Wallet or single-address: shipping (wallet selection) is authoritative.
  if ((wallet || singleAddress) && shippingIn.address1) {
    const shared = { ...shippingIn };
    return {
      billing: { ...shared, ...(email ? { email } : {}) },
      shipping: { ...shared },
    };
  }

  if (singleAddress && billingIn.address1) {
    const { email: _e, ...ship } = billingIn;
    return {
      billing: billingIn,
      shipping: { ...ship },
    };
  }

  // Distinct shipping + billing (express with shipToDifferentAddress true).
  // Prefer shipping for any missing billing street so profile billing cannot linger.
  if (shippingIn.address1 && !billingIn.address1) {
    return {
      billing: { ...shippingIn, ...(email ? { email } : {}) },
      shipping: shippingIn,
    };
  }

  return { billing: billingIn, shipping: shippingIn };
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
  const resultKey = `checkout:idemp:${key}`;
  const lockKey = `checkout:lock:${key}`;
  const ttlSec = 60 * 60;
  const lockTtlMs = 90_000;

  const cached = await redis.get(resultKey);
  if (cached) {
    return JSON.parse(cached) as T;
  }

  const token = `${Date.now()}-${Math.random()}`;
  let acquired =
    (await redis.set(lockKey, token, "PX", lockTtlMs, "NX")) === "OK";

  if (!acquired) {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const again = await redis.get(resultKey);
      if (again) {
        return JSON.parse(again) as T;
      }
      const lockHeld = await redis.get(lockKey);
      if (!lockHeld) {
        acquired =
          (await redis.set(lockKey, token, "PX", lockTtlMs, "NX")) === "OK";
        if (acquired) break;
      }
    }
  }

  if (!acquired) {
    const late = await redis.get(resultKey);
    if (late) {
      return JSON.parse(late) as T;
    }
    throw new Error("Your checkout is already being processed. Please wait.");
  }

  try {
    const again = await redis.get(resultKey);
    if (again) {
      return JSON.parse(again) as T;
    }
    const result = await fn();
    await redis.set(resultKey, JSON.stringify(result), "EX", ttlSec);
    return result;
  } finally {
    const current = await redis.get(lockKey);
    if (current === token) {
      await redis.del(lockKey);
    }
  }
}



async function assertCartInStock(
  items: Array<{ productId: number; variationId: number | null; quantity: number }>,
) {
  for (const item of items) {
    await assertInStock(item.productId, item.variationId, item.quantity);
  }
}




async function markOrderPaymentFailed(
  orderId: number,
  requestId: string | undefined,
): Promise<void> {
  try {
    await updateWcOrder(orderId, { status: "failed" });
    logJson("info", {
      msg: "process_order_payment_marked_failed",
      requestId,
      orderId,
    });
  } catch (err) {
    logJson("error", {
      msg: "process_order_payment_mark_failed_error",
      requestId,
      orderId,
      err: String(err),
    });
  }
}

async function assertCartCouponEmails(
  cart: { coupons: string[]; billing: { email?: string }; customerId: number | null },
  userId: number | null,
): Promise<void> {
  if (!cart.coupons.length) return;
  const candidates: Array<string | null | undefined> = [cart.billing.email];
  const ids = new Set<number>();
  if (userId) ids.add(userId);
  if (cart.customerId) ids.add(cart.customerId);
  for (const id of ids) {
    const user = await findUserById(id);
    if (user?.email) candidates.push(user.email);
  }
  const emails = normalizeApplicantEmails(candidates);
  const holder = {
    couponCodes: cart.coupons,
    customerId: userId ?? cart.customerId,
    billingEmail: emails[0] ?? cart.billing.email ?? null,
  };
  await assertCouponNotRedeemedOnPaidOrder(holder);
  await assertCouponUsageLimitLikeWoo(holder);
  await assertCouponNotHeldByUnpaidOrder(holder);
  for (const code of cart.coupons) {
    const coupon = await loadCoupon(code);
    if (!coupon) continue;
    assertCouponApplicable(coupon);
    assertCouponEmailAllowed(coupon, emails);
  }
}

export const checkoutResolvers = {
  Query: {
    paypalSettings: async () => getPaypalPublicSettings(),
  },
  Mutation: {
    createPayPalOrder: async (
      _: unknown,
      {
        input,
      }: {
        input?: {
          clientMutationId?: string | null;
          orderId?: number | null;
          orderKey?: string | null;
        } | null;
      },
      ctx: AppContext,
    ) => {
      const orderId = input?.orderId != null ? Number(input.orderId) : null;

      if (orderId != null && Number.isFinite(orderId) && orderId > 0) {
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
          throw new Error(
            `Order does not need payment (status: ${ctxOrder.status})`,
          );
        }

        const orderKey = (input?.orderKey || ctxOrder.orderKey || "").trim();
        if (
          ctxOrder.orderKey &&
          input?.orderKey &&
          input.orderKey !== ctxOrder.orderKey
        ) {
          throw new Error("Invalid orderKey");
        }
        if (!orderKey) {
          throw new Error("orderKey is required");
        }

        const paypal = await createPaypalOrder({
          amount: ctxOrder.total,
          currency: ctxOrder.currency || "USD",
          customId: String(orderId),
          invoiceId: `wc-${orderId}`,
        });

        return {
          clientMutationId: input?.clientMutationId ?? null,
          id: paypal.id,
          status: paypal.status,
        };
      }

      const cart = await loadCart(ctx.sessionToken);
      if (!cart.items.length) throw new Error("Cart is empty");
      await assertCartInStock(cart.items);
      await assertCartCouponEmails(cart, ctx.userId ?? null);

      const calculated = await calculateCart(cart, "full", {
        userId: ctx.userId,
      });
      await saveCart(ctx.sessionToken, calculated.cart);
      assertCheckoutTaxCalculated(cart, calculated);

      const paypal = await createPaypalOrder({
        amount: calculated.total,
        currency: "USD",
      });

      return {
        clientMutationId: input?.clientMutationId ?? null,
        id: paypal.id,
        status: paypal.status,
      };
    },

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
      await assertCartCouponEmails(cart, userId);

      // WC prices line items; we only need totals for shipping_lines / coupons.
      const calculated = await calculateCart(cart, "full", { userId });
      await saveCart(ctx.sessionToken, calculated.cart);

      const idempKey = createHash("sha256")
        .update(`${ctx.sessionToken}:${JSON.stringify(cart.items)}:create`)
        .digest("hex");

      const payload = await withCheckoutIdempotency(idempKey, async () => {
        // Ensure browser sent mc-wp-session cookie for later Store API payment; do not
        // send it on WC REST — a customer Cookie demotes admin consumer keys.
        await requireSyncedWpSession(ctx);
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
      logPaymentTrace("info", {
        msg: "checkout_start",
        requestId: ctx.requestId,
        jwtUserId: userId,
        guestCheckout: userId == null,
        paymentMethod: input.paymentMethod || "stripe",
        ...paymentAuthSnapshot(ctx),
      });
      const cart = await mutateCart(ctx.sessionToken, async (c) => {
        const resolved = resolveCheckoutAddresses({
          billing: input.billing,
          shipping: input.shipping,
          shipToDifferentAddress: input.shipToDifferentAddress,
          metaData: input.metaData,
        });
        // Replace (don't merge) so stale cart/profile billing cannot linger.
        c.billing = { ...resolved.billing };
        c.shipping = { ...resolved.shipping };
        if (userId) c.customerId = userId;
        return { cart: c, result: c };
      });

      if (!cart.items.length) throw new Error("Cart is empty");
      await assertCartInStock(cart.items);
      await assertCartCouponEmails(cart, userId ?? null);

      // Line item prices are not sent to WC — it recalculates from catalog.
      // calculateCart is still needed for shipping_lines / free-shipping thresholds.
      const calculated = await calculateCart(cart, "full", { userId });
      await saveCart(ctx.sessionToken, calculated.cart);
      assertCheckoutTaxCalculated(cart, calculated);

      const meta = (input.metaData ?? [])
        .filter((m) => m.key)
        .map((m) => ({ key: m.key, value: String(m.value ?? "") }));

      const idempKey = createHash("sha256")
        .update(
          `${ctx.sessionToken}:${JSON.stringify(cart.items)}:${JSON.stringify(meta)}:${JSON.stringify({ billing: cart.billing, shipping: cart.shipping })}:checkout`,
        )
        .digest("hex");

      const wcOrder = await withCheckoutIdempotency(idempKey, async () => {
        // WC REST uses consumer key/secret (admin). Do not attach the WP auth
        // cookie — WordPress would run as the customer and reject create with
        // "Sorry, you are not allowed to create resources." Cookie is only for
        // Store API payment. Still require it now so pay won't fail after place.
        if (userId != null) {
          await requireSyncedWpSession(ctx);
        }
        const wcPayload = buildWcOrderFromCart({
          cart: calculated.cart,
          calculated,
          paymentMethod: input.paymentMethod || "stripe",
          customerNote: input.customerNote,
          metaData: meta,
          customerId: userId ?? 0,
        });
        const started = Date.now();
        try {
          const order = await createWcOrder(wcPayload);
          logPaymentTrace("info", {
            msg: "checkout_ok",
            requestId: ctx.requestId,
            ms: Date.now() - started,
            orderId: order.id,
            jwtUserId: userId ?? null,
            guestCheckout: userId == null,
            paymentMethod: input.paymentMethod || "stripe",
            cartTotal: calculated.total,
            ...paymentAuthSnapshot(ctx),
          });
          return order;
        } catch (err) {
          logPaymentTrace("error", {
            msg: "checkout_fail",
            requestId: ctx.requestId,
            ms: Date.now() - started,
            jwtUserId: userId ?? null,
            guestCheckout: userId == null,
            paymentMethod: input.paymentMethod || "stripe",
            err: String(err),
            ...paymentAuthSnapshot(ctx),
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

      const tax =
        calculated.taxBreakdown ??
        emptyTaxBreakdown({
          message: "Tax was not calculated",
          subtotal: calculated.subtotal,
          shippingTotal: calculated.shippingTotal,
          total: calculated.total,
        });

      return {
        clientMutationId: input.clientMutationId,
        customer,
        order,
        redirect: null,
        result: "success",
        tax,
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

      logPaymentTrace("info", {
        msg: "process_order_payment_start",
        requestId: ctx.requestId,
        orderId,
        jwtUserId: ctx.userId,
        guestPayment: ctx.userId == null,
        paymentMethod: input.paymentMethod || null,
        orderKeyProvided: Boolean(input.orderKey?.trim()),
        billingEmailProvided: Boolean(input.billingEmail?.trim()),
        ...summarizePaymentData(
          (input.paymentData ?? []).map((p) => ({
            key: p.key,
            value: p.value ?? null,
          })),
        ),
        ...paymentAuthSnapshot(ctx),
      });

      const ctxOrder = await getOrderPaymentContext(orderId);
      if (!ctxOrder) throw new Error("Order not found");

      logPaymentTrace("info", {
        msg: "process_order_payment_order_context",
        requestId: ctx.requestId,
        orderId,
        orderCustomerId: ctxOrder.customerId,
        orderStatus: ctxOrder.status,
        orderNeedsPayment: ctxOrder.needsPayment,
        orderPaymentMethod: ctxOrder.paymentMethod,
        orderBillingEmail: ctxOrder.billing?.email ?? null,
        jwtUserId: ctx.userId,
      });

      // Ownership checks
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
        (ctxOrder.billing?.email || input.billingEmail || "").trim() ||
        undefined;
      if (ctxOrder.customerId === 0 && !billingEmail) {
        throw new Error("billingEmail is required for guest orders");
      }

      // Guest email must match order billing
      if (ctxOrder.customerId === 0 && billingEmail) {
        const orderEmail = (ctxOrder.billing?.email || "").trim().toLowerCase();
        const providedEmail = billingEmail.toLowerCase();
        if (orderEmail && orderEmail !== providedEmail) {
          throw new Error("Billing email does not match order");
        }
      }

      const paymentMethod =
        input.paymentMethod || ctxOrder.paymentMethod || "stripe";
      const paymentDataEntries = input.paymentData ?? [];

      // Extract payment method identifiers from payment data
      const paymentMethodId = paymentDataEntries.find(
        (p) =>
          (p.key === "_stripe_source_id" ||
            p.key === "stripe_source_id" ||
            p.key === "wc-stripe-payment-method") &&
          typeof p.value === "string" &&
          /^(pm_|src_|tok_|card_)/i.test(p.value),
      )?.value;

      const paypalOrderId = paymentDataEntries.find(
        (p) =>
          (p.key === "paypal_order_id" || p.key === "paypalOrderId") &&
          typeof p.value === "string" &&
          p.value.length > 0,
      )?.value;

      const started = Date.now();
      let result: string;
      let redirect: string | null = null;
      let clientSecret: string | null = null;
      let publishableKey: string | null = null;
      let requiresAction = false;
      const paymentDetails: Array<{ key: string; value: string }> = [];

      try {
        // Direct Stripe payment processing
        if (isStripePaymentMethod(paymentMethod)) {
          logPaymentTrace("info", {
            msg: "process_order_payment_stripe_start",
            requestId: ctx.requestId,
            orderId,
            hasPaymentMethodId: Boolean(paymentMethodId),
          });

          const stripeResult = await createPaymentIntent({
            amount: ctxOrder.total,
            currency: ctxOrder.currency,
            orderId,
            orderKey,
            customerId: ctxOrder.customerId > 0 ? ctxOrder.customerId : null,
            paymentMethodId: paymentMethodId || null,
            customerEmail: billingEmail || null,
          });

          clientSecret = stripeResult.clientSecret;
          publishableKey = getStripePublishableKey();
          requiresAction = stripeResult.requiresAction;

          if (stripeResult.status === "succeeded") {
            result = "success";
            paymentDetails.push({
              key: "stripe_intent_id",
              value: stripeResult.id,
            });

            // Mark WC order paid via REST
            await updateWcOrder(orderId, {
              status: "processing",
              set_paid: true,
              transaction_id: stripeResult.id,
            });

            logPaymentTrace("info", {
              msg: "process_order_payment_stripe_success",
              requestId: ctx.requestId,
              orderId,
              intentId: stripeResult.id,
              ms: Date.now() - started,
            });
          } else if (stripeResult.requiresAction) {
            result = "pending";
            paymentDetails.push({
              key: "stripe_intent_id",
              value: stripeResult.id,
            });
            logPaymentTrace("info", {
              msg: "process_order_payment_stripe_requires_action",
              requestId: ctx.requestId,
              orderId,
              intentId: stripeResult.id,
              ms: Date.now() - started,
            });
          } else {
            result = "pending";
            paymentDetails.push({
              key: "stripe_intent_id",
              value: stripeResult.id,
            });
            logPaymentTrace("info", {
              msg: "process_order_payment_stripe_pending",
              requestId: ctx.requestId,
              orderId,
              intentId: stripeResult.id,
              status: stripeResult.status,
              ms: Date.now() - started,
            });
          }
        }
        // Direct PayPal payment processing
        else if (isPaypalPaymentMethod(paymentMethod)) {
          if (!paypalOrderId) {
            throw new Error("paypal_order_id is required for PayPal payment");
          }

          logPaymentTrace("info", {
            msg: "process_order_payment_paypal_start",
            requestId: ctx.requestId,
            orderId,
            paypalOrderId,
          });

          const paypalResult = await capturePaypalOrder({
            paypalOrderId,
            orderId,
            expectedAmount: ctxOrder.total,
            expectedCurrency: ctxOrder.currency,
          });

          result = paypalResult.succeeded ? "success" : "failure";

          if (paypalResult.succeeded) {
            paymentDetails.push({
              key: "paypal_order_id",
              value: paypalOrderId,
            });
            paymentDetails.push({
              key: "transaction_id",
              value: paypalResult.id,
            });

            // Mark WC order paid via REST
            await updateWcOrder(orderId, {
              status: "processing",
              set_paid: true,
              transaction_id: paypalResult.id,
            });

            logPaymentTrace("info", {
              msg: "process_order_payment_paypal_success",
              requestId: ctx.requestId,
              orderId,
              paypalOrderId,
              captureId: paypalResult.id,
              ms: Date.now() - started,
            });
          } else {
            await markOrderPaymentFailed(orderId, ctx.requestId);
            logPaymentTrace("error", {
              msg: "process_order_payment_paypal_failure",
              requestId: ctx.requestId,
              orderId,
              paypalOrderId,
              status: paypalResult.status,
              ms: Date.now() - started,
            });
          }
        } else {
          throw new Error(`Unsupported payment method: ${paymentMethod}`);
        }
      } catch (err) {
        logPaymentTrace("error", {
          msg: "process_order_payment_fail",
          requestId: ctx.requestId,
          ms: Date.now() - started,
          orderId,
          jwtUserId: ctx.userId,
          guestPayment: ctx.userId == null,
          paymentMethod,
          err: String(err),
          ...paymentAuthSnapshot(ctx),
        });
        await markOrderPaymentFailed(orderId, ctx.requestId);
        throw err;
      }

      const needs = orderNeedsFromInfo(info, ["order"]);
      const order =
        (await shapeOrder(orderId, needs)) ??
        (await getOrderById(orderId, ctx.userId));

      return {
        clientMutationId: input.clientMutationId,
        order,
        result,
        redirect,
        paymentStatus: result,
        paymentDetails,
        clientSecret,
        publishableKey,
        requiresAction,
      };
    },
  },
};

void parseDatabaseId;
