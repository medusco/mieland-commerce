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

/**
 * Create or retrieve a Stripe PaymentIntent for the given order.
 * Idempotent: uses orderId + orderKey as idempotency key to prevent double-charges.
 */
export async function createPaymentIntent(
  args: CreatePaymentIntentArgs,
): Promise<PaymentIntentResult> {
  const stripe = getStripeClient();
  const amountCents = Math.round(Number(args.amount) * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error(`Invalid payment amount: ${args.amount}`);
  }

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
};

/**
 * Retrieve and validate a Stripe PaymentIntent.
 * Verifies that the amount and order_id metadata match to prevent fraud.
 */
export async function confirmPaymentIntent(
  args: ConfirmPaymentIntentArgs,
): Promise<ConfirmPaymentIntentResult> {
  const stripe = getStripeClient();
  const started = Date.now();

  try {
    const intent = await stripe.paymentIntents.retrieve(args.paymentIntentId);

    logJson("info", {
      msg: "stripe_retrieve_payment_intent",
      ms: Date.now() - started,
      intentId: intent.id,
      status: intent.status,
      orderId: args.orderId,
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

    return {
      status: intent.status,
      succeeded: intent.status === "succeeded",
      amount: intentAmountDollars,
      currency: intent.currency.toUpperCase(),
      orderId: args.orderId,
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
