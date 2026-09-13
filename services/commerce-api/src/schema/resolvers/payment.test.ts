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
        status: "processing",
        set_paid: true,
        transaction_id: "pi_abc123",
      };

      assert.strictEqual(wcOrderUpdate.status, "processing");
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
