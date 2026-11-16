import { describe, it } from "node:test";
import assert from "node:assert";
import type Stripe from "stripe";
import { GraphQLError } from "graphql";
import {
  ensurePaymentMethodAttachedForSubscription,
  validateRetrievedPaymentMethodForSubscription,
} from "../clients/stripe.js";
import type { PaymentToken } from "../repositories/payment-tokens.js";
import { pickSavedStripePaymentToken } from "../repositories/payment-tokens.js";
import type { WcOrderPayload } from "../clients/woocommerce-rest.js";
import {
  applyZeroSubscriptionPaidToWcCreatePayload,
  buildZeroSubscriptionPaidOrderMeta,
  ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED,
  ZERO_SUBSCRIPTION_CHECKOUT_TRANSACTION_PREFIX,
  zeroSubscriptionPaymentMethodRequiredError,
} from "./zero-subscription-complete.js";
import {
  cartItemsHaveSubscription,
  shouldAutoCompleteZeroSubscriptionAtCheckout,
  shouldAutoMarkZeroNonSubscriptionPaid,
} from "./zero-order.js";

function tokenRow(
  partial: Partial<PaymentToken> & Pick<PaymentToken, "id" | "token" | "isDefault">,
): PaymentToken {
  return {
    userId: 1,
    gateway: "stripe",
    type: "CC",
    ...partial,
  };
}

describe("Zero subscription checkout", () => {
  it("rejects guest or missing card with ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED", () => {
    const err = zeroSubscriptionPaymentMethodRequiredError();
    assert.ok(err instanceof GraphQLError);
    assert.strictEqual(
      err.extensions?.code,
      ZERO_SUBSCRIPTION_PAYMENT_METHOD_REQUIRED,
    );
    assert.ok(err.message.includes("saved Stripe card"));
  });

  it("selects default Stripe token, otherwise first", () => {
    const tokens = [
      tokenRow({ id: 10, token: "pm_b", isDefault: false }),
      tokenRow({ id: 20, token: "pm_a", isDefault: true }),
    ];
    const picked = pickSavedStripePaymentToken(tokens);
    assert.strictEqual(picked?.id, 20);
    assert.strictEqual(picked?.token, "pm_a");

    const onlyNonDefault = [
      tokenRow({ id: 30, token: "pm_c", isDefault: false }),
      tokenRow({ id: 31, token: "pm_d", isDefault: false }),
    ];
    assert.strictEqual(pickSavedStripePaymentToken(onlyNonDefault)?.id, 30);
    assert.strictEqual(pickSavedStripePaymentToken([]), null);
  });

  it("puts set_paid and renewal meta on WC order create payload (not post-create update)", () => {
    const base: WcOrderPayload = {
      payment_method: "stripe",
      billing: {},
      shipping: {},
      line_items: [{ product_id: 1, quantity: 1 }],
      meta_data: [{ key: "client_ref", value: "abc" }],
    };
    const pmDetails = {
      paymentMethodId: "pm_create",
      customerId: "cus_create",
      cardBrand: "visa" as string | null,
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
    };
    const created = applyZeroSubscriptionPaidToWcCreatePayload(base, {
      pmDetails,
      wcPaymentTokenId: 55,
    });
    assert.strictEqual(created.set_paid, true);
    assert.strictEqual(created.payment_method, "stripe");
    assert.strictEqual(created.payment_method_title, "Credit Card (Stripe)");
    assert.strictEqual(
      created.transaction_id,
      ZERO_SUBSCRIPTION_CHECKOUT_TRANSACTION_PREFIX,
    );
    assert.ok(
      created.meta_data?.some(
        (m) => m.key === "_stripe_source_id" && m.value === "pm_create",
      ),
    );
    assert.ok(
      created.meta_data?.some(
        (m) =>
          m.key === "_mieland_zero_subscription_completed" &&
          m.value.length > 0,
      ),
    );
    assert.ok(
      created.meta_data?.some(
        (m) => m.key === "client_ref" && m.value === "abc",
      ),
    );
  });

  it("builds order meta for paid $0 subscription checkout", () => {
    const meta = buildZeroSubscriptionPaidOrderMeta({
      pmDetails: {
        paymentMethodId: "pm_test",
        customerId: "cus_test",
        cardBrand: "visa",
        last4: "4242",
        expMonth: 1,
        expYear: 2030,
      },
      wcPaymentTokenId: 99,
    });
    const keys = meta.map((m) => m.key);
    assert.ok(keys.includes("_stripe_customer_id"));
    assert.ok(keys.includes("_stripe_source_id"));
    assert.ok(keys.includes("wc-stripe-payment-method"));
    assert.ok(keys.includes("_mieland_zero_subscription_completed"));
    assert.ok(keys.includes("_payment_tokens"));
    assert.ok(keys.includes("_requires_manual_renewal"));
    assert.strictEqual(
      meta.find((m) => m.key === "_requires_manual_renewal")?.value,
      "false",
    );
    assert.strictEqual(meta.find((m) => m.key === "_payment_tokens")?.value, "99");
  });

  it("attaches detached PaymentMethod to expected customer", async () => {
    let attachCalled = false;
    const stripeMock = {
      paymentMethods: {
        retrieve: async (id: string) => ({
          id,
          customer: null,
          card: { brand: "visa", last4: "4242", exp_month: 1, exp_year: 2030 },
        }),
        attach: async (id: string, params: { customer: string }) => {
          attachCalled = true;
          assert.strictEqual(id, "pm_detach");
          assert.strictEqual(params.customer, "cus_expected");
          return {
            id,
            customer: params.customer,
            card: {
              brand: "visa",
              last4: "4242",
              exp_month: 1,
              exp_year: 2030,
            },
          };
        },
      },
    } as unknown as Stripe;

    const result = await ensurePaymentMethodAttachedForSubscription(
      {
        paymentMethodId: "pm_detach",
        expectedCustomerId: "cus_expected",
        userId: 5,
      },
      stripeMock,
    );

    assert.strictEqual(attachCalled, true);
    assert.strictEqual(result.customerId, "cus_expected");
    assert.strictEqual(result.paymentMethodId, "pm_detach");
  });

  it("skips attach when PaymentMethod already on customer", async () => {
    let attachCalled = false;
    const stripeMock = {
      paymentMethods: {
        retrieve: async (id: string) => ({
          id,
          customer: "cus_expected",
          card: null,
        }),
        attach: async () => {
          attachCalled = true;
          throw new Error("attach should not run");
        },
      },
    } as unknown as Stripe;

    await ensurePaymentMethodAttachedForSubscription(
      {
        paymentMethodId: "pm_ok",
        expectedCustomerId: "cus_expected",
        userId: 5,
      },
      stripeMock,
    );
    assert.strictEqual(attachCalled, false);
  });

  it("detects subscription lines on cart", () => {
    assert.strictEqual(
      cartItemsHaveSubscription([
        {
          key: "x",
          productId: 1,
          variationId: 0,
          quantity: 1,
          extraData: [{ key: "_subscription_frequency", value: "monthly" }],
        },
      ]),
      true,
    );
    assert.strictEqual(
      cartItemsHaveSubscription([
        {
          key: "x",
          productId: 1,
          variationId: 0,
          quantity: 1,
          extraData: [],
        },
      ]),
      false,
    );
  });

  it("keeps one-time $0 auto-pay path unchanged", () => {
    assert.strictEqual(shouldAutoMarkZeroNonSubscriptionPaid(0, false), true);
    assert.strictEqual(shouldAutoCompleteZeroSubscriptionAtCheckout(0, true), true);
    assert.strictEqual(shouldAutoMarkZeroNonSubscriptionPaid(0, true), false);
  });

  it("validateRetrievedPaymentMethodForSubscription still rejects wrong customer", () => {
    assert.throws(
      () =>
        validateRetrievedPaymentMethodForSubscription(
          { id: "pm_x", customer: "cus_other", card: null },
          {
            paymentMethodId: "pm_x",
            expectedCustomerId: "cus_expected",
            userId: 1,
          },
        ),
      /attached to customer/,
    );
  });
});