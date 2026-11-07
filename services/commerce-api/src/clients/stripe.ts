import Stripe from "stripe";
import { loadConfig } from "../config.js";
import { logJson } from "../utils/index.js";

let stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
  if (stripeClient) return stripeClient;
  const cfg = loadConfig();
  if (!cfg.STRIPE_SECRET_KEY) {
    throw new Error(
      "Stripe is not configured (set STRIPE_SECRET_KEY environment variable)",
    );
  }
  stripeClient = new Stripe(cfg.STRIPE_SECRET_KEY, {
    apiVersion: "2025-02-24.acacia",
    typescript: true,
  });
  return stripeClient;
}

export function getStripePublishableKey(): string {
  const cfg = loadConfig();
  if (!cfg.STRIPE_PUBLISHABLE_KEY) {
    throw new Error(
      "Stripe publishable key is not configured (set STRIPE_PUBLISHABLE_KEY environment variable)",
    );
  }
  return cfg.STRIPE_PUBLISHABLE_KEY;
}

export type CreatePaymentIntentArgs = {
  amount: string;
  currency: string;
  orderId: number;
  orderKey: string;
  customerId?: number | null;
  paymentMethodId?: string | null;
  customerEmail?: string | null;
};

export type PaymentIntentResult = {
  id: string;
  clientSecret: string;
  status: string;
  requiresAction: boolean;
};

/** Validates order total string before Stripe PaymentIntent creation (rejects ≤ 0). */
export function assertPositivePaymentAmountCents(amount: string): number {
  const amountCents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error(
      `Invalid payment amount: ${amount}. ` +
        `For $0 orders, use processOrderPayment with a saved payment method instead of creating a PaymentIntent.`,
    );
  }
  return amountCents;
}

/**
 * Create or retrieve a Stripe PaymentIntent for the given order.
 * Idempotent: uses orderId + orderKey as idempotency key to prevent double-charges.
 */
export async function createPaymentIntent(
  args: CreatePaymentIntentArgs,
): Promise<PaymentIntentResult> {
  const stripe = getStripeClient();
  const amountCents = assertPositivePaymentAmountCents(args.amount);

  const idempotencyKey = `order-${args.orderId}-${args.orderKey}`;
  const metadata: Stripe.MetadataParam = {
    order_id: String(args.orderId),
    order_key: args.orderKey,
  };
  if (args.customerId) {
    metadata.customer_id = String(args.customerId);
  }

  const params: Stripe.PaymentIntentCreateParams = {
    amount: amountCents,
    currency: args.currency.toLowerCase(),
    metadata,
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: "never",
    },
  };

  if (args.paymentMethodId) {
    params.payment_method = args.paymentMethodId;
    params.confirm = true;
    params.return_url = "https://mielandmanuka.com/checkout/order-received";
  }

  if (args.customerEmail) {
    params.receipt_email = args.customerEmail;
  }

  const started = Date.now();
  try {
    const intent = await stripe.paymentIntents.create(params, {
      idempotencyKey,
    });

    logJson("info", {
      msg: "stripe_create_payment_intent",
      ms: Date.now() - started,
      intentId: intent.id,
      status: intent.status,
      orderId: args.orderId,
      amount: args.amount,
      currency: args.currency,
      requiresAction: intent.status === "requires_action",
    });

    return {
      id: intent.id,
      clientSecret: intent.client_secret!,
      status: intent.status,
      requiresAction: intent.status === "requires_action",
    };
  } catch (err) {
    logJson("error", {
      msg: "stripe_create_payment_intent_fail",
      ms: Date.now() - started,
      orderId: args.orderId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export type ConfirmPaymentIntentArgs = {
  paymentIntentId: string;
  orderId: number;
  expectedAmount: string;
};

export type ConfirmPaymentIntentResult = {
  status: string;
  succeeded: boolean;
  amount: string;
  currency: string;
  orderId: number;
  paymentIntentId: string;
  chargeId: string | null;
};

export type ValidatePaymentMethodArgs = {
  paymentMethodId: string;
  expectedCustomerId: string;
  userId: number;
};

const STRIPE_CUSTOMER_ID_META = "_stripe_customer_id";

export type ValidatePaymentMethodResult = {
  paymentMethodId: string;
  customerId: string;
  cardBrand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
};

function normalizeStripeCustomerId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed?.startsWith("cus_")) return null;
  return trimmed;
}

/**
 * Resolve the Stripe customer ID that must own the payment method for $0 subscriptions.
 * Logged-in: user meta `_stripe_customer_id`, then saved payment token `customer_id`.
 * Guest: order meta `_stripe_customer_id` only.
 */
export async function resolveExpectedStripeCustomerId(args: {
  userId: number;
  orderStripeCustomerId?: string | null;
}): Promise<string | null> {
  if (args.userId > 0) {
    const { getUserMeta } = await import("../auth/index.js");
    const fromUser = normalizeStripeCustomerId(
      await getUserMeta(args.userId, STRIPE_CUSTOMER_ID_META),
    );
    if (fromUser) return fromUser;
    return normalizeStripeCustomerId(await getStripeCustomerIdForUser(args.userId));
  }
  return normalizeStripeCustomerId(args.orderStripeCustomerId ?? null);
}

export type StripePaymentMethodLike = {
  id: string;
  customer: string | { id: string } | null;
  card?: {
    brand?: string | null;
    last4?: string | null;
    exp_month?: number | null;
    exp_year?: number | null;
  } | null;
};

/**
 * Validate a retrieved PaymentMethod belongs to the expected Stripe customer.
 */
export function validateRetrievedPaymentMethodForSubscription(
  pm: StripePaymentMethodLike,
  args: ValidatePaymentMethodArgs,
): ValidatePaymentMethodResult {
  if (!pm.customer) {
    throw new Error(
      `Payment method ${args.paymentMethodId} is not attached to any Stripe customer. ` +
        `Create a SetupIntent with the customer parameter to attach the payment method.`,
    );
  }

  const customerId =
    typeof pm.customer === "string" ? pm.customer : pm.customer.id;

  if (customerId !== args.expectedCustomerId) {
    throw new Error(
      `Payment method ${args.paymentMethodId} is attached to customer ${customerId}, ` +
        `but order belongs to customer ${args.expectedCustomerId}`,
    );
  }

  const card = pm.card;
  return {
    paymentMethodId: pm.id,
    customerId,
    cardBrand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
  };
}

/**
 * Get the Stripe customer ID for a WordPress user from saved payment tokens.
 * Returns the customer ID from the most recent stripe payment token, or null if none exists.
 */
export async function getStripeCustomerIdForUser(
  userId: number,
): Promise<string | null> {
  const { query, t } = await import("../db/mysql.js");
  
  try {
    const row = await query<{ meta_value: string }[]>(
      `SELECT ptm.meta_value
       FROM ${t("woocommerce_payment_tokens")} pt
       INNER JOIN ${t("woocommerce_payment_tokenmeta")} ptm
         ON ptm.payment_token_id = pt.token_id
       WHERE pt.user_id = ?
         AND pt.gateway_id = 'stripe'
         AND ptm.meta_key = 'customer_id'
       ORDER BY pt.token_id DESC
       LIMIT 1`,
      [userId],
    );

    if (row.length > 0 && row[0]?.meta_value) {
      const customerId = row[0].meta_value.trim();
      if (customerId.startsWith("cus_")) {
        return customerId;
      }
    }
    return null;
  } catch (err) {
    logJson("warn", {
      msg: "get_stripe_customer_id_failed",
      userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Retrieve and validate a Stripe PaymentMethod for $0 subscription orders.
 * Ensures the payment method is attached to the correct customer for renewals.
 */
export async function validatePaymentMethodForSubscription(
  args: ValidatePaymentMethodArgs,
  stripeClient?: Stripe,
): Promise<ValidatePaymentMethodResult> {
  const stripe = stripeClient ?? getStripeClient();
  const started = Date.now();

  try {
    const pm = await stripe.paymentMethods.retrieve(args.paymentMethodId);

    logJson("info", {
      msg: "stripe_retrieve_payment_method",
      ms: Date.now() - started,
      paymentMethodId: args.paymentMethodId,
      hasCustomer: Boolean(pm.customer),
    });

    return validateRetrievedPaymentMethodForSubscription(pm, args);
  } catch (err) {
    logJson("error", {
      msg: "stripe_validate_payment_method_fail",
      ms: Date.now() - started,
      paymentMethodId: args.paymentMethodId,
      userId: args.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Retrieve and validate a Stripe PaymentIntent.
 * Verifies that the amount and order_id metadata match to prevent fraud.
 * Expands latest_charge to include the charge ID for order notes.
 */
export async function confirmPaymentIntent(
  args: ConfirmPaymentIntentArgs,
): Promise<ConfirmPaymentIntentResult> {
  const stripe = getStripeClient();
  const started = Date.now();

  try {
    const intent = await stripe.paymentIntents.retrieve(args.paymentIntentId, {
      expand: ["latest_charge"],
    });

    logJson("info", {
      msg: "stripe_retrieve_payment_intent",
      ms: Date.now() - started,
      intentId: intent.id,
      status: intent.status,
      orderId: args.orderId,
      hasCharge: Boolean(intent.latest_charge),
    });

    const metadataOrderId = Number(intent.metadata.order_id);
    if (metadataOrderId !== args.orderId) {
      throw new Error(
        `PaymentIntent order_id mismatch: expected ${args.orderId}, got ${metadataOrderId}`,
      );
    }

    const intentAmountDollars = (intent.amount / 100).toFixed(2);
    const expectedAmountDollars = Number(args.expectedAmount).toFixed(2);
    if (intentAmountDollars !== expectedAmountDollars) {
      throw new Error(
        `PaymentIntent amount mismatch: expected ${expectedAmountDollars}, got ${intentAmountDollars}`,
      );
    }

    const chargeId =
      typeof intent.latest_charge === "string"
        ? intent.latest_charge
        : intent.latest_charge?.id ?? null;

    return {
      status: intent.status,
      succeeded: intent.status === "succeeded",
      amount: intentAmountDollars,
      currency: intent.currency.toUpperCase(),
      orderId: args.orderId,
      paymentIntentId: intent.id,
      chargeId,
    };
  } catch (err) {
    logJson("error", {
      msg: "stripe_retrieve_payment_intent_fail",
      ms: Date.now() - started,
      intentId: args.paymentIntentId,
      orderId: args.orderId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
