import { GraphQLError } from "graphql";
import type Stripe from "stripe";
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
import { linkSubscriptionPaymentForParentOrder } from "../repositories/subscriptions.js";
import { logJson } from "../utils/index.js";

export const ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED =
  "ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED";

export const ZERO_SUBSCRIPTION_PAYMENT_METHOD_MESSAGE =
  "A saved Stripe card is required to start a $0 subscription checkout. " +
  "Sign in and add a payment method in My Account, then try again.";

export function zeroSubscriptionPaymentMethodRequiredError(): GraphQLError {
  return new GraphQLError(ZERO_SUBSCRIPTION_PAYMENT_METHOD_MESSAGE, {
    extensions: { code: ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED },
  });
}

export type SavedWcStripeToken = {
  tokenId: number;
  paymentMethodId: string;
};

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
 * Validate Stripe PM, mark WC order paid with renewal meta, and link hy_mieland_subscriptions when present.
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

  await addWcOrderNote(args.orderId, {
    note:
      `$0 subscription order completed with saved payment method ` +
      `(${pmDetails.paymentMethodId}, customer ${pmDetails.customerId}, token ${args.wcPaymentTokenId})`,
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
    paymentMethodId: pmDetails.paymentMethodId,
    stripeCustomerId: pmDetails.customerId,
    wcPaymentTokenId: args.wcPaymentTokenId,
    subscriptionsLinked: linked,
  });

  return pmDetails;
}

export function isZeroSubscriptionCartCheckout(
  cartTotal: unknown,
  hasSubscriptions: boolean,
): boolean {
  return isWcZeroOrderTotal(cartTotal) && hasSubscriptions;
}