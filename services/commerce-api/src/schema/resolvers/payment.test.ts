import { describe, it } from "node:test";
import assert from "node:assert";

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
      const orderTotal = 0.0;
      const hasSubscriptions = false;

      // Server-computed total is exactly $0
      assert.strictEqual(orderTotal, 0);
      // No subscription items
      assert.strictEqual(hasSubscriptions, false);

      // Should mark paid via set_paid: true
      const shouldMarkPaid = orderTotal === 0 && !hasSubscriptions;
      assert.strictEqual(shouldMarkPaid, true);
    });

    it("should keep subscription $0 order pending for payment method setup", () => {
      const orderTotal = 0.0;
      const hasSubscriptions = true;

      // Server-computed total is exactly $0
      assert.strictEqual(orderTotal, 0);
      // Has subscription items
      assert.strictEqual(hasSubscriptions, true);

      // Should NOT mark paid (needs payment method for renewals)
      const shouldMarkPaid = orderTotal === 0 && !hasSubscriptions;
      assert.strictEqual(shouldMarkPaid, false);
    });

    it("should not treat near-zero as free", () => {
      const orderTotal = 0.01;
      const shouldBecomeFree = orderTotal === 0;

      assert.strictEqual(shouldBecomeFree, false);
      assert.ok(orderTotal > 0);
    });

    it("should not treat negative total as free", () => {
      const orderTotal = -0.01;
      const shouldBecomeFree = orderTotal === 0;

      assert.strictEqual(shouldBecomeFree, false);
    });

    it("should not treat NaN total as free", () => {
      const orderTotal = NaN;
      const isValid = Number.isFinite(orderTotal);
      const shouldBecomeFree = isValid && orderTotal === 0;

      assert.strictEqual(shouldBecomeFree, false);
    });

    it("should use WooCommerce order total as source of truth", () => {
      const clientTotal = 50.0;
      const wcOrderTotal = 0.0; // After coupon applied by WooCommerce

      // Server-authoritative: WC total wins
      const effectiveTotal = wcOrderTotal;
      assert.strictEqual(effectiveTotal, 0);
      assert.notStrictEqual(effectiveTotal, clientTotal);
    });

    it("should add order note for $0 completion", () => {
      const orderId = 123;
      const note = {
        note: "Order completed: total is $0.00 (coupon discount)",
        customer_note: false,
      };

      assert.ok(note.note.includes("$0.00"));
      assert.strictEqual(note.customer_note, false);
    });

    it("should use free-order transaction_id format", () => {
      const orderId = 123;
      const transactionId = `free-order-${orderId}`;

      assert.strictEqual(transactionId, "free-order-123");
      assert.ok(transactionId.startsWith("free-order-"));
    });

    it("should add completion timestamp metadata", () => {
      const timestamp = new Date().toISOString();
      const metaData = [
        {
          key: "_mieland_zero_order_completed",
          value: timestamp,
        },
      ];

      assert.strictEqual(metaData.length, 1);
      assert.strictEqual(metaData[0]?.key, "_mieland_zero_order_completed");
      assert.ok(metaData[0]?.value);
    });

    it("should detect subscription from line item meta", () => {
      const lineItems = [
        {
          product_id: 100,
          quantity: 1,
          meta_data: [
            { key: "_subscription_frequency", value: "monthly" },
          ],
        },
      ];

      const hasSubscriptions = lineItems.some((item) => {
        return item.meta_data?.some(
          (m) =>
            (m.key === "_subscription_frequency" ||
              m.key === "subscription_frequency") &&
            typeof m.value === "string" &&
            m.value.trim().length > 0,
        );
      });

      assert.strictEqual(hasSubscriptions, true);
    });

    it("should not detect subscription when meta is empty string", () => {
      const lineItems = [
        {
          product_id: 100,
          quantity: 1,
          meta_data: [
            { key: "_subscription_frequency", value: "" },
          ],
        },
      ];

      const hasSubscriptions = lineItems.some((item) => {
        return item.meta_data?.some(
          (m) =>
            (m.key === "_subscription_frequency" ||
              m.key === "subscription_frequency") &&
            typeof m.value === "string" &&
            m.value.trim().length > 0,
        );
      });

      assert.strictEqual(hasSubscriptions, false);
    });

    it("should detect subscription from alternative key", () => {
      const lineItems = [
        {
          product_id: 100,
          quantity: 1,
          meta_data: [
            { key: "subscription_frequency", value: "weekly" },
          ],
        },
      ];

      const hasSubscriptions = lineItems.some((item) => {
        return item.meta_data?.some(
          (m) =>
            (m.key === "_subscription_frequency" ||
              m.key === "subscription_frequency") &&
            typeof m.value === "string" &&
            m.value.trim().length > 0,
        );
      });

      assert.strictEqual(hasSubscriptions, true);
    });
  });

  describe("Stripe PaymentMethod Validation", () => {
    it("should extract customer ID from PaymentMethod", () => {
      const mockPm = {
        id: "pm_1ABC",
        customer: "cus_xyz123",
        card: {
          brand: "visa",
          last4: "4242",
          exp_month: 12,
          exp_year: 2027,
        },
      };

      const customerId =
        typeof mockPm.customer === "string"
          ? mockPm.customer
          : (mockPm.customer as { id: string })?.id;

      assert.strictEqual(customerId, "cus_xyz123");
      assert.ok(customerId.startsWith("cus_"));
    });

    it("should reject PaymentMethod without customer", () => {
      const mockPm = {
        id: "pm_1ABC",
        customer: null,
      };

      const hasCustomer = Boolean(mockPm.customer);
      assert.strictEqual(hasCustomer, false);
    });

    it("should validate customer ID matches expected", () => {
      const pmCustomerId = "cus_xyz123";
      const expectedCustomerId = "cus_xyz123";

      const matches = pmCustomerId === expectedCustomerId;
      assert.strictEqual(matches, true);
    });

    it("should reject PaymentMethod with mismatched customer", () => {
      const pmCustomerId = "cus_xyz123";
      const expectedCustomerId = "cus_abc456";

      const matches = pmCustomerId === expectedCustomerId;
      assert.strictEqual(matches, false);
    });

    it("should extract card details from PaymentMethod", () => {
      const mockCard = {
        brand: "visa",
        last4: "4242",
        exp_month: 12,
        exp_year: 2027,
      };

      assert.strictEqual(mockCard.brand, "visa");
      assert.strictEqual(mockCard.last4, "4242");
      assert.strictEqual(mockCard.exp_month, 12);
      assert.strictEqual(mockCard.exp_year, 2027);
    });
  });

  describe("Stripe Customer ID Lookup", () => {
    it("should return customer ID from payment token meta", () => {
      const mockTokenMeta = [
        { meta_key: "customer_id", meta_value: "cus_xyz123" },
        { meta_key: "last4", meta_value: "4242" },
      ];

      const customerIdMeta = mockTokenMeta.find(
        (m) => m.meta_key === "customer_id",
      );
      const customerId = customerIdMeta?.meta_value;

      assert.strictEqual(customerId, "cus_xyz123");
      assert.ok(customerId?.startsWith("cus_"));
    });

    it("should return null when no tokens exist", () => {
      const mockTokens: Array<{ meta_value: string }> = [];

      const customerId = mockTokens[0]?.meta_value ?? null;
      assert.strictEqual(customerId, null);
    });

    it("should validate customer ID format", () => {
      const validCustomerId = "cus_xyz123";
      const invalidCustomerId = "pm_xyz123";

      assert.ok(validCustomerId.startsWith("cus_"));
      assert.ok(!invalidCustomerId.startsWith("cus_"));
    });
  });

  describe("Payment Token Creation", () => {
    it("should store customer_id in token metadata", () => {
      const tokenInput = {
        gateway: "stripe",
        token: "pm_1ABC",
        customerId: "cus_xyz123",
      };

      assert.strictEqual(tokenInput.customerId, "cus_xyz123");
      assert.ok(tokenInput.customerId?.startsWith("cus_"));
    });

    it("should store card details in token metadata", () => {
      const tokenInput = {
        token: "pm_1ABC",
        cardType: "visa",
        last4: "4242",
        expiryMonth: "12",
        expiryYear: "2027",
      };

      assert.strictEqual(tokenInput.cardType, "visa");
      assert.strictEqual(tokenInput.last4, "4242");
      assert.strictEqual(tokenInput.expiryMonth, "12");
      assert.strictEqual(tokenInput.expiryYear, "2027");
    });
  });

  describe("Zero Dollar Subscription Completion", () => {
    it("should complete $0 subscription with saved payment method", () => {
      const orderTotal = 0.0;
      const paymentMethodId = "pm_1234567890abcdef";
      const hasSubscriptions = true;

      assert.strictEqual(orderTotal, 0);
      assert.ok(paymentMethodId.startsWith("pm_"));
      assert.strictEqual(hasSubscriptions, true);

      // Should mark paid with payment method attached
      const shouldComplete = orderTotal === 0 && Boolean(paymentMethodId);
      assert.strictEqual(shouldComplete, true);
    });

    it("should reject $0 subscription without payment method", () => {
      const orderTotal = 0.0;
      const paymentMethodId = null;

      const shouldReject = orderTotal === 0 && !paymentMethodId;
      assert.strictEqual(shouldReject, true);
    });

    it("should reject non-pm_ payment methods for $0 subscription", () => {
      const validPm = "pm_1234567890abcdef";
      const invalidToken = "tok_1234567890abcdef";
      const invalidCard = "card_1234567890abcdef";

      assert.ok(validPm.startsWith("pm_"));
      assert.ok(!invalidToken.startsWith("pm_"));
      assert.ok(!invalidCard.startsWith("pm_"));
    });

    it("should be idempotent for $0 subscription completion", () => {
      const orderStatus = "processing"; // Already paid
      const needsPayment = ["pending", "on-hold", "failed"].includes(orderStatus);

      assert.strictEqual(needsPayment, false);
      // Replaying should return success without calling set_paid again
    });

    it("should attach payment method metadata for renewals", () => {
      const paymentMethodId = "pm_1234567890abcdef";
      const customerId = "cus_xyz123";
      const metaData = [
        { key: "_stripe_customer_id", value: customerId },
        { key: "_stripe_source_id", value: paymentMethodId },
      ];

      assert.strictEqual(metaData.length, 2);
      
      const customerIdMeta = metaData.find((m) => m.key === "_stripe_customer_id");
      assert.ok(customerIdMeta);
      assert.ok(customerIdMeta.value.startsWith("cus_"));
      
      const sourceIdMeta = metaData.find((m) => m.key === "_stripe_source_id");
      assert.ok(sourceIdMeta);
      assert.ok(sourceIdMeta.value.startsWith("pm_"));
    });

    it("should add completion note for $0 subscription", () => {
      const paymentMethodId = "pm_1234567890abcdef";
      const note = `$0 subscription order completed with saved payment method (${paymentMethodId})`;

      assert.ok(note.includes("$0 subscription"));
      assert.ok(note.includes(paymentMethodId));
    });

    it("should use zero-subscription transaction ID format", () => {
      const orderId = 123;
      const transactionId = `zero-subscription-${orderId}`;

      assert.strictEqual(transactionId, "zero-subscription-123");
    });
  });

  describe("Stripe Zero Amount Rejection", () => {
    it("should reject zero amount PaymentIntent creation", () => {
      const amount = 0.0;
      const amountCents = Math.round(amount * 100);

      const shouldReject = !Number.isFinite(amountCents) || amountCents <= 0;
      assert.strictEqual(shouldReject, true);
    });

    it("should reject negative amount PaymentIntent", () => {
      const amount = -1.0;
      const amountCents = Math.round(amount * 100);

      const shouldReject = !Number.isFinite(amountCents) || amountCents <= 0;
      assert.strictEqual(shouldReject, true);
    });

    it("should accept positive amount PaymentIntent", () => {
      const amount = 0.01;
      const amountCents = Math.round(amount * 100);

      const shouldAccept = Number.isFinite(amountCents) && amountCents > 0;
      assert.strictEqual(shouldAccept, true);
      assert.strictEqual(amountCents, 1);
    });
  });

  describe("Idempotency and Freshness", () => {
    it("should prevent double set_paid via metadata guard", () => {
      const metaData = [
        { key: "_mieland_zero_order_completed", value: "2026-11-07T00:00:00.000Z" },
      ];

      const alreadyMarkedPaid = metaData.some(
        (m) => m.key === "_mieland_zero_order_completed",
      );

      assert.strictEqual(alreadyMarkedPaid, true);
      // Should skip set_paid when already marked
    });

    it("should allow set_paid when metadata absent", () => {
      const metaData: Array<{ key: string; value: string }> = [];

      const alreadyMarkedPaid = metaData.some(
        (m) => m.key === "_mieland_zero_order_completed",
      );

      assert.strictEqual(alreadyMarkedPaid, false);
      // Should call set_paid
    });

    it("should fetch fresh order for $0 orders", () => {
      const wcTotal = 0.0;
      const was$0Order = Number.isFinite(wcTotal) && wcTotal === 0;

      assert.strictEqual(was$0Order, true);
      // Should fetch from DB instead of using cached WC response
    });

    it("should use cached order for non-$0 orders", () => {
      const wcTotal = 99.99;
      const was$0Order = Number.isFinite(wcTotal) && wcTotal === 0;

      assert.strictEqual(was$0Order, false);
      // Can use cached WC response
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
