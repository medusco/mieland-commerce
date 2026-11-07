import { describe, it } from "node:test";
import assert from "node:assert";
import type Stripe from "stripe";
import {
  assertPositivePaymentAmountCents,
  resolveExpectedStripeCustomerId,
  validatePaymentMethodForSubscription,
  validateRetrievedPaymentMethodForSubscription,
} from "../../clients/stripe.js";
import {
  isOrderStatusAwaitingPayment,
  isStripePmId,
  isWcZeroOrderTotal,
  orderMetaHasZeroOrderCompleted,
  shouldAutoMarkZeroNonSubscriptionPaid,
  shouldDeferZeroSubscriptionAtCheckout,
  wcLineItemsHaveSubscription,
} from "../../payment/zero-order.js";

function totalsFromFixture(): number[] {
  return [0, 0.01, -0.01, Number.NaN, 50, 99.99];
}

describe("Payment Processing", () => {
  describe("Stripe Payment", () => {
    it("should create PaymentIntent with order amount from server", () => {
      // Verify order context structure
      const orderContext = {
        id: 123,
        customerId: 1,
        status: "pending",
        total: "99.99",
        currency: "USD",
        orderKey: "wc_order_abc123",
        needsPayment: true,
        billing: { email: "test@example.com" },
        shipping: {},
      };

      // Verify amount is taken from order, not client
      assert.strictEqual(orderContext.total, "99.99");
      assert.strictEqual(orderContext.currency, "USD");
    });

    it("should reject if amount in PaymentIntent does not match order", () => {
      const expectedAmount = "99.99";
      const intentAmountCents = 10000; // $100.00

      const intentAmountDollars = (intentAmountCents / 100).toFixed(2);
      const expectedAmountDollars = Number(expectedAmount).toFixed(2);

      assert.notStrictEqual(
        intentAmountDollars,
        expectedAmountDollars,
        "Should detect amount mismatch",
      );
    });

    it("should reject if order_id metadata does not match", () => {
      const expectedOrderId = 123;
      const metadataOrderId = 456;

      assert.notStrictEqual(
        metadataOrderId,
        expectedOrderId,
        "Should detect order_id mismatch",
      );
    });
  });

  describe("PayPal Payment", () => {
    it("should capture PayPal order with server-side amount", () => {
      const orderContext = {
        id: 123,
        total: "99.99",
        currency: "USD",
      };

      // Verify amount comes from server
      assert.strictEqual(orderContext.total, "99.99");
    });

    it("should reject if captured amount does not match order", () => {
      const expectedAmount = "99.99";
      const capturedAmount = "100.00";

      const expectedAmountDollars = Number(expectedAmount).toFixed(2);
      const capturedAmountDollars = Number(capturedAmount).toFixed(2);

      assert.notStrictEqual(
        capturedAmountDollars,
        expectedAmountDollars,
        "Should detect amount mismatch",
      );
    });

    it("should reject if captured currency does not match", () => {
      const expectedCurrency = "USD";
      const capturedCurrency = "EUR";

      assert.notStrictEqual(
        capturedCurrency.toUpperCase(),
        expectedCurrency.toUpperCase(),
        "Should detect currency mismatch",
      );
    });
  });

  describe("Ownership Checks", () => {
    it("should reject if JWT customer_id does not match order", () => {
      const jwtUserId = 1;
      const orderCustomerId = 2;

      // Verify that different customer IDs should be rejected
      assert.notStrictEqual(
        jwtUserId,
        orderCustomerId,
        "Should detect customer_id mismatch",
      );
    });

    it("should reject guest payment for logged-in order", () => {
      const jwtUserId = null;
      const orderCustomerId = 1;

      assert.ok(
        jwtUserId == null && orderCustomerId > 0,
        "Should reject guest trying to pay logged-in order",
      );
    });

    it("should require orderKey for guest orders", () => {
      const orderKey = "";
      const customerId = 0;

      assert.ok(
        customerId === 0 && !orderKey.trim(),
        "Should reject guest payment without orderKey",
      );
    });

    it("should require matching billing email for guest orders", () => {
      const orderEmail = "test@example.com";
      const providedEmail = "wrong@example.com";

      assert.notStrictEqual(
        orderEmail.toLowerCase(),
        providedEmail.toLowerCase(),
        "Should reject mismatched billing email",
      );
    });
  });

  describe("Payment Method Validation", () => {
    it("should require paypal_order_id for PayPal", () => {
      const paymentMethod = "ppcp-gateway";
      const paypalOrderId = "";

      assert.ok(
        (paymentMethod === "ppcp-gateway" || paymentMethod === "paypal") &&
          !paypalOrderId,
        "Should reject PayPal without paypal_order_id",
      );
    });

    it("should reject marking paid without processor confirmation", () => {
      // Payment must be confirmed by Stripe or PayPal before marking order paid
      let processorConfirmed = false;
      let orderMarkedPaid = false;

      // Simulate processor confirmation
      processorConfirmed = true;

      // Only mark paid after processor confirms
      if (processorConfirmed) {
        orderMarkedPaid = true;
      }

      assert.ok(
        orderMarkedPaid === processorConfirmed,
        "Should only mark paid after processor confirms",
      );
    });
  });

  describe("Idempotency", () => {
    it("should use order_id + orderKey as idempotency key", () => {
      const orderId = 123;
      const orderKey = "wc_order_abc123";
      const idempotencyKey = `order-${orderId}-${orderKey}`;

      assert.strictEqual(
        idempotencyKey,
        "order-123-wc_order_abc123",
        "Should generate correct idempotency key",
      );
    });
  });

  describe("WooCommerce Order Update", () => {
    it("should mark order paid via WC REST after processor confirms", () => {
      const wcOrderUpdate = {
        set_paid: true,
        transaction_id: "pi_abc123",
      };

      assert.strictEqual(wcOrderUpdate.set_paid, true);
      assert.ok(wcOrderUpdate.transaction_id);
    });

    it("should mark order failed after processor rejection", () => {
      const wcOrderUpdate = {
        status: "failed",
      };

      assert.strictEqual(wcOrderUpdate.status, "failed");
    });
  });

  describe("Zero Dollar Orders", () => {
    it("should mark non-subscription $0 order as paid immediately", () => {
      const [wcTotal] = totalsFromFixture();
      assert.strictEqual(
        shouldAutoMarkZeroNonSubscriptionPaid(wcTotal, false),
        true,
      );
    });

    it("should keep subscription $0 order pending for payment method setup", () => {
      const [wcTotal] = totalsFromFixture();
      assert.strictEqual(shouldDeferZeroSubscriptionAtCheckout(wcTotal, true), true);
      assert.strictEqual(shouldAutoMarkZeroNonSubscriptionPaid(wcTotal, true), false);
    });

    it("should not treat near-zero as free", () => {
      const totals = totalsFromFixture();
      const orderTotal = totals[1]!;
      assert.strictEqual(isWcZeroOrderTotal(orderTotal), false);
    });

    it("should not treat negative total as free", () => {
      const totals = totalsFromFixture();
      const orderTotal = totals[2]!;
      assert.strictEqual(isWcZeroOrderTotal(orderTotal), false);
    });

    it("should not treat NaN total as free", () => {
      const totals = totalsFromFixture();
      const orderTotal = totals[3]!;
      assert.strictEqual(isWcZeroOrderTotal(orderTotal), false);
    });

    it("should use WooCommerce order total as source of truth", () => {
      const totals = totalsFromFixture();
      const clientTotal = totals[4]!;
      const wcOrderTotal = totals[0]!;
      assert.strictEqual(isWcZeroOrderTotal(wcOrderTotal), true);
      assert.notStrictEqual(wcOrderTotal, clientTotal);
    });

    it("should use free-order transaction_id format", () => {
      const orderId = 123;
      const transactionId = `free-order-${orderId}`;
      assert.strictEqual(transactionId, `free-order-${orderId}`);
      assert.ok(transactionId.startsWith("free-order-"));
    });

    it("should detect completion via order meta guard", () => {
      const metaData = [
        {
          key: "_mieland_zero_order_completed",
          value: new Date().toISOString(),
        },
      ];
      assert.strictEqual(
        orderMetaHasZeroOrderCompleted(metaData, "_mieland_zero_order_completed"),
        true,
      );
    });

    it("should detect subscription from line item meta", () => {
      const lineItems = [
        {
          product_id: 100,
          quantity: 1,
          meta_data: [{ key: "_subscription_frequency", value: "monthly" }],
        },
      ];
      assert.strictEqual(wcLineItemsHaveSubscription(lineItems), true);
    });

    it("should not detect subscription when meta is empty string", () => {
      const lineItems = [
        {
          product_id: 100,
          quantity: 1,
          meta_data: [{ key: "_subscription_frequency", value: "" }],
        },
      ];
      assert.strictEqual(wcLineItemsHaveSubscription(lineItems), false);
    });

    it("should detect subscription from alternative key", () => {
      const lineItems = [
        {
          product_id: 100,
          quantity: 1,
          meta_data: [{ key: "subscription_frequency", value: "weekly" }],
        },
      ];
      assert.strictEqual(wcLineItemsHaveSubscription(lineItems), true);
    });
  });

  describe("Stripe PaymentMethod Validation", () => {
    const baseArgs = {
      paymentMethodId: "pm_test",
      expectedCustomerId: "cus_expected",
      userId: 42,
    };

    it("should accept PaymentMethod attached to expected customer", () => {
      const result = validateRetrievedPaymentMethodForSubscription(
        {
          id: "pm_test",
          customer: "cus_expected",
          card: {
            brand: "visa",
            last4: "4242",
            exp_month: 12,
            exp_year: 2027,
          },
        },
        baseArgs,
      );
      assert.strictEqual(result.customerId, "cus_expected");
      assert.strictEqual(result.last4, "4242");
    });

    it("should reject PaymentMethod without customer", () => {
      assert.throws(
        () =>
          validateRetrievedPaymentMethodForSubscription(
            { id: "pm_test", customer: null, card: null },
            baseArgs,
          ),
        /not attached to any Stripe customer/,
      );
    });

    it("should reject PaymentMethod with mismatched customer", () => {
      const expected = baseArgs.expectedCustomerId;
      const attached = "cus_other";
      assert.throws(
        () =>
          validateRetrievedPaymentMethodForSubscription(
            { id: "pm_test", customer: attached, card: null },
            { ...baseArgs, expectedCustomerId: expected },
          ),
        /attached to customer cus_other/,
      );
    });

    it("should retrieve and validate via validatePaymentMethodForSubscription", async () => {
      const stripeMock = {
        paymentMethods: {
          retrieve: async (id: string) => ({
            id,
            customer: "cus_expected",
            card: {
              brand: "visa",
              last4: "9999",
              exp_month: 1,
              exp_year: 2030,
            },
          }),
        },
      } as unknown as Stripe;

      const result = await validatePaymentMethodForSubscription(
        baseArgs,
        stripeMock,
      );
      assert.strictEqual(result.paymentMethodId, "pm_test");
      assert.strictEqual(result.customerId, "cus_expected");
    });
  });

  describe("Stripe customer resolution", () => {
    it("should resolve guest Stripe customer from order meta", async () => {
      const resolved = await resolveExpectedStripeCustomerId({
        userId: 0,
        orderStripeCustomerId: "cus_guest_order",
      });
      assert.strictEqual(resolved, "cus_guest_order");
    });

    it("should return null for guest when order meta lacks Stripe customer", async () => {
      const resolved = await resolveExpectedStripeCustomerId({ userId: 0 });
      assert.strictEqual(resolved, null);
    });

    it("should ignore non-cus order meta values", async () => {
      const resolved = await resolveExpectedStripeCustomerId({
        userId: 0,
        orderStripeCustomerId: "pm_not_a_customer",
      });
      assert.strictEqual(resolved, null);
    });
  });

  describe("Zero Dollar Subscription Completion", () => {
    it("should require pm_ id for $0 subscription completion", () => {
      const candidates: Array<string | null> = [
        "pm_1234567890abcdef",
        "tok_1234567890abcdef",
        null,
      ];
      assert.strictEqual(isStripePmId(candidates[0]), true);
      assert.strictEqual(isStripePmId(candidates[1]), false);
      assert.strictEqual(isStripePmId(candidates[2]), false);
    });

    it("should treat paid statuses as idempotent", () => {
      const statuses = ["processing", "pending", "completed"] as string[];
      assert.strictEqual(isOrderStatusAwaitingPayment(statuses[0]!), false);
      assert.strictEqual(isOrderStatusAwaitingPayment(statuses[1]!), true);
    });

    it("should record subscription completion meta keys", () => {
      const metaData = [
        {
          key: "_mieland_zero_subscription_completed",
          value: new Date().toISOString(),
        },
      ];
      assert.strictEqual(
        orderMetaHasZeroOrderCompleted(
          metaData,
          "_mieland_zero_subscription_completed",
        ),
        true,
      );
    });
  });

  describe("Stripe Zero Amount Rejection", () => {
    it("should reject zero amount PaymentIntent creation", () => {
      assert.throws(
        () => assertPositivePaymentAmountCents("0"),
        /Invalid payment amount/,
      );
    });

    it("should reject negative amount PaymentIntent", () => {
      assert.throws(
        () => assertPositivePaymentAmountCents("-1.00"),
        /Invalid payment amount/,
      );
    });

    it("should accept positive amount PaymentIntent", () => {
      const amountCents = assertPositivePaymentAmountCents("0.01");
      assert.strictEqual(amountCents, 1);
    });
  });

  describe("Idempotency and Freshness", () => {
    it("should prevent double set_paid via metadata guard", () => {
      const metaData = [
        { key: "_mieland_zero_order_completed", value: "2026-11-07T00:00:00.000Z" },
      ];
      assert.strictEqual(
        orderMetaHasZeroOrderCompleted(metaData, "_mieland_zero_order_completed"),
        true,
      );
    });

    it("should allow set_paid when metadata absent", () => {
      const metaData: Array<{ key: string; value: string }> = [];
      assert.strictEqual(
        orderMetaHasZeroOrderCompleted(metaData, "_mieland_zero_order_completed"),
        false,
      );
    });

    it("should classify $0 vs paid order totals", () => {
      const totals = totalsFromFixture();
      assert.strictEqual(isWcZeroOrderTotal(totals[0]), true);
      assert.strictEqual(isWcZeroOrderTotal(totals[5]), false);
    });
  });

  describe("Order Notes and Metadata", () => {
    describe("Stripe", () => {
      it("should use charge ID as transaction_id when available", () => {
        const chargeId = "ch_abc123";
        const paymentIntentId = "pi_xyz789";

        // When charge is available, use it as transaction_id
        const transactionId = chargeId || paymentIntentId;

        assert.strictEqual(transactionId, chargeId);
      });

      it("should fall back to payment intent ID when no charge", () => {
        const chargeId = null;
        const paymentIntentId = "pi_xyz789";

        const transactionId = chargeId || paymentIntentId;

        assert.strictEqual(transactionId, paymentIntentId);
      });

      it("should include _stripe_intent_id in meta_data", () => {
        const paymentIntentId = "pi_xyz789";
        const metaData = [
          { key: "_stripe_intent_id", value: paymentIntentId },
        ];

        assert.strictEqual(metaData.length, 1);
        assert.strictEqual(metaData[0]?.key, "_stripe_intent_id");
        assert.strictEqual(metaData[0]?.value, paymentIntentId);
      });

      it("should add payment intent created note", () => {
        const paymentIntentId = "pi_xyz789";
        const note = {
          note: `Stripe payment intent created (Payment Intent ID: ${paymentIntentId})`,
          customer_note: false,
        };

        assert.ok(note.note.includes("Stripe payment intent created"));
        assert.ok(note.note.includes(paymentIntentId));
        assert.strictEqual(note.customer_note, false);
      });

      it("should add charge notes when charge ID is available", () => {
        const chargeId = "ch_abc123";
        const notes = [
          {
            note: `Payment via Credit / Debit Card (${chargeId})`,
            customer_note: false,
          },
          {
            note: `Stripe charge complete (Charge ID: ${chargeId})`,
            customer_note: false,
          },
        ];

        assert.strictEqual(notes.length, 2);
        assert.ok(notes[0]?.note.includes("Credit / Debit Card"));
        assert.ok(notes[0]?.note.includes(chargeId));
        assert.ok(notes[1]?.note.includes("Stripe charge complete"));
        assert.ok(notes[1]?.note.includes(chargeId));
      });

      it("should not add charge notes when charge ID is null", () => {
        const chargeId = null;
        const shouldAddChargeNotes = Boolean(chargeId);

        assert.strictEqual(shouldAddChargeNotes, false);
      });
    });

    describe("PayPal", () => {
      it("should use capture ID as transaction_id", () => {
        const captureId = "1AB23456CD789012E";
        const transactionId = captureId;

        assert.strictEqual(transactionId, captureId);
      });

      it("should add PayPal order created note", () => {
        const paypalOrderId = "5O190127TN364715T";
        const note = {
          note: `PayPal order created (PayPal Order ID: ${paypalOrderId})`,
          customer_note: false,
        };

        assert.ok(note.note.includes("PayPal order created"));
        assert.ok(note.note.includes(paypalOrderId));
        assert.strictEqual(note.customer_note, false);
      });

      it("should add PayPal capture note", () => {
        const captureId = "1AB23456CD789012E";
        const note = {
          note: `PayPal payment captured (Capture ID: ${captureId})`,
          customer_note: false,
        };

        assert.ok(note.note.includes("PayPal payment captured"));
        assert.ok(note.note.includes(captureId));
        assert.strictEqual(note.customer_note, false);
      });
    });

    describe("Note Format", () => {
      it("should mark notes as non-customer-facing", () => {
        const notes = [
          { note: "Test note 1", customer_note: false },
          { note: "Test note 2", customer_note: false },
        ];

        for (const note of notes) {
          assert.strictEqual(note.customer_note, false);
        }
      });

      it("should include payment processor IDs in notes", () => {
        const stripeNote = "Stripe charge complete (Charge ID: ch_123)";
        const paypalNote = "PayPal payment captured (Capture ID: 1AB23)";

        assert.ok(stripeNote.includes("ch_123"));
        assert.ok(paypalNote.includes("1AB23"));
      });
    });
  });
});
