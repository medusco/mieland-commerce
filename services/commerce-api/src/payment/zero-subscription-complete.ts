import { GraphQLError } from "graphql";
import type Stripe from "stripe";
import type { WcOrderPayload } from "../clients/woocommerce-rest.js";
import {
  ensurePaymentMethodAttachedForSubscription,
  resolveExpectedStripeCustomerId,
  type ValidatePaymentMethodResult,
} from "../clients/stripe.js";
import { addWcOrderNote, updateWcOrder } from "../clients/woocommerce-rest.js";
import {
  orderMetaHasZeroOrderCompleted,
  isWcZeroOrderTotal,
} from "./zero-order.js";
import {
  cancelSubscriptionsForParentOrder,
  linkSubscriptionPaymentForParentOrder,
} from "../repositories/subscriptions.js";
import { logJson } from "../utils/index.js";

export const ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED =
  "ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED";

export const ZERO_SUBSCRIPTION_CHECKOUT_TRANSACTION_PREFIX = "zero-subscription";

export const ZERO_SUBSCRIPTION_PAYMENT_METHOD_MESSAGE =
  "A saved Stripe card is required to start a $0 subscription checkout. " +
  "Sign in and add a payment method in My Account, then try again.";

export const ZERO_SUBSCRIPTION_TOTAL_MISMATCH = "ZERO_SUBSCRIPTION_TOTAL_MISMATCH";

export const ZERO_SUBSCRIPTION_TOTAL_MISMATCH_MESSAGE =
  "Your order total changed during checkout. Please review your cart and try again.";

export function zeroSubscriptionPaymentMethodRequiredError(): GraphQLError {
  return new GraphQLError(ZERO_SUBSCRIPTION_PAYMENT_METHOD_MESSAGE, {
    extensions: { code: ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED },
  });
}

export function zeroSubscriptionTotalMismatchError(): GraphQLError {
  return new GraphQLError(ZERO_SUBSCRIPTION_TOTAL_MISMATCH_MESSAGE, {
    extensions: { code: ZERO_SUBSCRIPTION_TOTAL_MISMATCH },
  });
}

export function isZeroSubscriptionCommerceWcTotalMismatch(
  zeroSubscriptionCheckout: boolean,
  wcOrderTotal: unknown,
): boolean {
  return zeroSubscriptionCheckout && !isWcZeroOrderTotal(wcOrderTotal);
}

export type ZeroSubscriptionMismatchCleanupActions = {
  setOrderOnHold: (orderId: number) => Promise<void>;
  addOrderNote: (orderId: number, note: string) => Promise<void>;
  cancelSubscriptions: (args: {
    parentOrderId: number;
    userId: number | null;
  }) => Promise<number>;
  logWarn: (payload: Record<string, unknown>) => void;
  logStepFailure: (payload: Record<string, unknown>) => void;
};

const defaultZeroSubscriptionMismatchActions: ZeroSubscriptionMismatchCleanupActions =
  {
    setOrderOnHold: async (orderId) => {
      await updateWcOrder(orderId, { status: "on-hold" });
    },
    addOrderNote: async (orderId, note) => {
      await addWcOrderNote(orderId, { note, customer_note: false });
    },
    cancelSubscriptions: async (args) =>
      cancelSubscriptionsForParentOrder(args),
    logWarn: (payload) => logJson("warn", payload),
    logStepFailure: (payload) => logJson("error", payload),
  };

function formatTotalForMismatchNote(total: unknown): string {
  const n = Number(total);
  if (Number.isFinite(n)) {
    return n.toFixed(2);
  }
  return String(total ?? "unknown");
}

/**
 * Commerce believed the cart was $0 but WooCommerce computed a non-zero total after create
 * (often after set_paid on create). Hold the order, cancel subscription rows, and fail checkout.
 */
export async function abortZeroSubscriptionOnWcTotalMismatch(
  args: {
    orderId: number;
    userId: number | null;
    commerceTotal: unknown;
    wcTotal: unknown;
    requestId?: string;
  },
  actions: ZeroSubscriptionMismatchCleanupActions = defaultZeroSubscriptionMismatchActions,
): Promise<never> {
  const commerceLabel = formatTotalForMismatchNote(args.commerceTotal);
  const wcLabel = formatTotalForMismatchNote(args.wcTotal);
  const note =
    `Zero-subscription checkout blocked: commerce cart total was $${commerceLabel} ` +
    `but WooCommerce order total is $${wcLabel}. Order placed on-hold and subscriptions ` +
    `cancelled pending review (pricing/coupon mismatch).`;

  try {
    await actions.setOrderOnHold(args.orderId);
  } catch (err) {
    actions.logStepFailure({
      msg: "zero_subscription_mismatch_set_on_hold_failed",
      orderId: args.orderId,
      userId: args.userId,
      err: String(err),
      requestId: args.requestId ?? null,
    });
  }

  try {
    await actions.addOrderNote(args.orderId, note);
  } catch (err) {
    actions.logStepFailure({
      msg: "zero_subscription_mismatch_note_failed",
      orderId: args.orderId,
      userId: args.userId,
      err: String(err),
      requestId: args.requestId ?? null,
    });
  }

  try {
    await actions.cancelSubscriptions({
      parentOrderId: args.orderId,
      userId: args.userId,
    });
  } catch (err) {
    actions.logStepFailure({
      msg: "zero_subscription_mismatch_cancel_subscriptions_failed",
      orderId: args.orderId,
      userId: args.userId,
      err: String(err),
      requestId: args.requestId ?? null,
    });
  }

  actions.logWarn({
    msg: "zero_subscription_total_mismatch",
    event: "zero_subscription_total_mismatch",
    orderId: args.orderId,
    userId: args.userId,
    commerceTotal: args.commerceTotal,
    wcTotal: args.wcTotal,
    requestId: args.requestId ?? null,
  });

  throw zeroSubscriptionTotalMismatchError();
}

export type SavedWcStripeToken = {
  tokenId: number;
  paymentMethodId: string;
};

export function mergeWcOrderMeta(
  base: Array<{ key: string; value: string }> | undefined,
  extra: Array<{ key: string; value: string }>,
): Array<{ key: string; value: string }> {
  const byKey = new Map<string, string>();
  for (const entry of base ?? []) {
    byKey.set(entry.key, entry.value);
  }
  for (const entry of extra) {
    byKey.set(entry.key, entry.value);
  }
  return [...byKey.entries()].map(([key, value]) => ({ key, value }));
}

export function buildZeroSubscriptionPaidOrderMeta(args: {
  pmDetails: ValidatePaymentMethodResult;
  wcPaymentTokenId: number;
}): Array<{ key: string; value: string }> {
  const now = new Date().toISOString();
  return [
    { key: "_stripe_customer_id", value: args.pmDetails.customerId },
    { key: "_stripe_source_id", value: args.pmDetails.paymentMethodId },
    {
      key: "wc-stripe-payment-method",
      value: args.pmDetails.paymentMethodId,
    },
    {
      key: "_mieland_zero_subscription_completed",
      value: now,
    },
    {
      key: "_payment_tokens",
      value: String(args.wcPaymentTokenId),
    },
    { key: "_requires_manual_renewal", value: "false" },
  ];
}

/**
 * WC REST order create must include set_paid + renewal meta so payment_complete runs
 * on create (WooCommerce skips it on later updates when needs_payment() is false for $0).
 */
export function applyZeroSubscriptionPaidToWcCreatePayload(
  payload: WcOrderPayload,
  args: {
    pmDetails: ValidatePaymentMethodResult;
    wcPaymentTokenId: number;
    transactionId?: string;
  },
): WcOrderPayload {
  const subscriptionMeta = buildZeroSubscriptionPaidOrderMeta({
    pmDetails: args.pmDetails,
    wcPaymentTokenId: args.wcPaymentTokenId,
  });
  return {
    ...payload,
    payment_method: "stripe",
    payment_method_title: "Credit Card (Stripe)",
    set_paid: true,
    transaction_id:
      args.transactionId ?? ZERO_SUBSCRIPTION_CHECKOUT_TRANSACTION_PREFIX,
    meta_data: mergeWcOrderMeta(payload.meta_data, subscriptionMeta),
  };
}

export async function validateZeroSubscriptionStripeBeforeCreate(args: {
  userId: number;
  paymentMethodId: string;
  stripeClient?: Stripe;
}): Promise<ValidatePaymentMethodResult> {
  const expectedCustomerId = await resolveExpectedStripeCustomerId({
    userId: args.userId,
  });
  if (!expectedCustomerId) {
    throw new Error(
      "Unable to resolve Stripe customer for $0 subscription checkout. " +
        "Ensure the account has a saved Stripe card.",
    );
  }

  return ensurePaymentMethodAttachedForSubscription(
    {
      paymentMethodId: args.paymentMethodId,
      expectedCustomerId,
      userId: args.userId,
    },
    args.stripeClient,
  );
}

export async function finalizeZeroSubscriptionOrderAfterCreate(args: {
  orderId: number;
  userId: number;
  wcPaymentTokenId: number;
  pmDetails: ValidatePaymentMethodResult;
  requestId?: string;
}): Promise<number> {
  await addWcOrderNote(args.orderId, {
    note:
      `$0 subscription order completed with saved payment method ` +
      `(${args.pmDetails.paymentMethodId}, customer ${args.pmDetails.customerId}, token ${args.wcPaymentTokenId})`,
    customer_note: false,
  });

  const linked = await linkSubscriptionPaymentForParentOrder({
    parentOrderId: args.orderId,
    userId: args.userId,
    wcPaymentTokenId: args.wcPaymentTokenId,
    paymentMethod: "stripe",
  });

  logJson("info", {
    msg: "zero_subscription_order_completed",
    requestId: args.requestId ?? null,
    orderId: args.orderId,
    userId: args.userId,
    paymentMethodId: args.pmDetails.paymentMethodId,
    stripeCustomerId: args.pmDetails.customerId,
    wcPaymentTokenId: args.wcPaymentTokenId,
    subscriptionsLinked: linked,
  });

  return linked;
}

export type CompleteZeroSubscriptionOrderPaidArgs = {
  orderId: number;
  userId: number;
  paymentMethodId: string;
  wcPaymentTokenId: number;
  existingMetaData?: unknown;
  orderStripeCustomerId?: string | null;
  requestId?: string;
  stripeClient?: Stripe;
};

/**
 * Legacy processOrderPayment path: order already exists unpaid — update via WC REST.
 */
export async function completeZeroSubscriptionOrderPaid(
  args: CompleteZeroSubscriptionOrderPaidArgs,
): Promise<ValidatePaymentMethodResult> {
  const alreadyCompleted = orderMetaHasZeroOrderCompleted(
    args.existingMetaData,
    "_mieland_zero_subscription_completed",
  );
  if (alreadyCompleted) {
    return {
      paymentMethodId: args.paymentMethodId,
      customerId: "",
      cardBrand: null,
      last4: null,
      expMonth: null,
      expYear: null,
    };
  }

  const expectedCustomerId = await resolveExpectedStripeCustomerId({
    userId: args.userId,
    orderStripeCustomerId: args.orderStripeCustomerId ?? null,
  });
  if (!expectedCustomerId) {
    throw new Error(
      "Unable to resolve Stripe customer for $0 subscription checkout. " +
        "Ensure the account has a saved Stripe card.",
    );
  }

  const pmDetails = await ensurePaymentMethodAttachedForSubscription(
    {
      paymentMethodId: args.paymentMethodId,
      expectedCustomerId,
      userId: args.userId,
    },
    args.stripeClient,
  );

  const meta_data = buildZeroSubscriptionPaidOrderMeta({
    pmDetails,
    wcPaymentTokenId: args.wcPaymentTokenId,
  });

  await updateWcOrder(args.orderId, {
    set_paid: true,
    payment_method: "stripe",
    payment_method_title: "Credit Card (Stripe)",
    transaction_id: `zero-subscription-${args.orderId}`,
    meta_data,
  });

  await finalizeZeroSubscriptionOrderAfterCreate({
    orderId: args.orderId,
    userId: args.userId,
    wcPaymentTokenId: args.wcPaymentTokenId,
    pmDetails,
    requestId: args.requestId,
  });

  return pmDetails;
}

export function isZeroSubscriptionCartCheckout(
  cartTotal: unknown,
  hasSubscriptions: boolean,
): boolean {
  return isWcZeroOrderTotal(cartTotal) && hasSubscriptions;
}