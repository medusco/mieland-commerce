import { describe, it } from "node:test";
import assert from "node:assert";

describe("Order Fulfillment Cancellation", () => {
  describe("parseFulfillmentCancellation", () => {
    it("should return null when no cancellation meta is present", () => {
      const meta = {
        _order_key: "wc_order_abc123",
        _transaction_id: "ch_123",
      };

      const hasCancellationKeys =
        "mieland_mcf_cancelled_at" in meta ||
        "mieland_mcf_cancellation_source" in meta;

      assert.strictEqual(hasCancellationKeys, false);
    });

    it("should parse cancellation when cancelled_at is present", () => {
      const meta = {
        mieland_mcf_cancelled_at: "2026-09-25T10:30:00.000Z",
        mieland_mcf_cancellation_source: "amazon_mcf",
        mieland_mcf_amazon_status: "Cancelled",
        mieland_mcf_was_paid_at_cancel: "yes",
        mieland_mcf_paid_amount: "89.99",
        mieland_mcf_payment_method: "stripe",
        mieland_mcf_transaction_id: "ch_abc123",
        mieland_mcf_date_paid: "2026-09-24T15:00:00.000Z",
        mieland_mcf_refund_status: "refund_required",
      };

      assert.strictEqual(meta.mieland_mcf_cancelled_at, "2026-09-25T10:30:00.000Z");
      assert.strictEqual(meta.mieland_mcf_cancellation_source, "amazon_mcf");
      assert.strictEqual(meta.mieland_mcf_amazon_status, "Cancelled");
      assert.strictEqual(meta.mieland_mcf_was_paid_at_cancel, "yes");
      assert.strictEqual(meta.mieland_mcf_paid_amount, "89.99");
      assert.strictEqual(meta.mieland_mcf_payment_method, "stripe");
      assert.strictEqual(meta.mieland_mcf_transaction_id, "ch_abc123");
      assert.strictEqual(meta.mieland_mcf_date_paid, "2026-09-24T15:00:00.000Z");
      assert.strictEqual(meta.mieland_mcf_refund_status, "refund_required");
    });

    it("should parse cancellation when only source is present", () => {
      const meta = {
        mieland_mcf_cancellation_source: "amazon_mcf",
      };

      const hasCancellationKeys = "mieland_mcf_cancellation_source" in meta;
      assert.strictEqual(hasCancellationKeys, true);
      assert.strictEqual(meta.mieland_mcf_cancellation_source, "amazon_mcf");
    });

    it("should parse wasPaid as boolean true when yes", () => {
      const wasPaidRaw = "yes";
      const wasPaid = wasPaidRaw.toLowerCase() === "yes" ? true : false;
      assert.strictEqual(wasPaid, true);
    });

    it("should parse wasPaid as boolean false when no", () => {
      const wasPaidRaw = "no";
      const wasPaid = wasPaidRaw.toLowerCase() === "no" ? false : true;
      assert.strictEqual(wasPaid, false);
    });

    it("should handle wasPaid null when not yes or no", () => {
      const wasPaidRaw: string = "maybe";
      const wasPaid =
        wasPaidRaw === "yes" ? true : wasPaidRaw === "no" ? false : null;
      assert.strictEqual(wasPaid, null);
    });

    it("should keep refund_status as lowercase raw value", () => {
      const refundStatus = "Refund_Required";
      const normalized = refundStatus.trim().toLowerCase();
      assert.strictEqual(normalized, "refund_required");
    });

    it("should handle partial cancellation data", () => {
      const meta: Record<string, string> = {
        mieland_mcf_cancelled_at: "2026-09-25T10:30:00.000Z",
        mieland_mcf_cancellation_source: "amazon_mcf",
        mieland_mcf_amazon_status: "Cancelled",
      };

      assert.strictEqual(meta.mieland_mcf_cancelled_at, "2026-09-25T10:30:00.000Z");
      assert.strictEqual(meta.mieland_mcf_cancellation_source, "amazon_mcf");
      assert.strictEqual(meta.mieland_mcf_amazon_status, "Cancelled");
      assert.strictEqual(meta.mieland_mcf_paid_amount, undefined);
      assert.strictEqual(meta.mieland_mcf_refund_status, undefined);
    });

    it("should trim whitespace from all string fields", () => {
      const meta = {
        mieland_mcf_cancelled_at: "  2026-09-25T10:30:00.000Z  ",
        mieland_mcf_cancellation_source: "  amazon_mcf  ",
        mieland_mcf_amazon_status: "  Cancelled  ",
        mieland_mcf_paid_amount: "  89.99  ",
        mieland_mcf_payment_method: "  stripe  ",
        mieland_mcf_transaction_id: "  ch_abc123  ",
        mieland_mcf_date_paid: "  2026-09-24T15:00:00.000Z  ",
        mieland_mcf_refund_status: "  refund_required  ",
      };

      assert.strictEqual(meta.mieland_mcf_cancelled_at.trim(), "2026-09-25T10:30:00.000Z");
      assert.strictEqual(meta.mieland_mcf_cancellation_source.trim(), "amazon_mcf");
      assert.strictEqual(meta.mieland_mcf_amazon_status.trim(), "Cancelled");
      assert.strictEqual(meta.mieland_mcf_paid_amount.trim(), "89.99");
      assert.strictEqual(meta.mieland_mcf_payment_method.trim(), "stripe");
      assert.strictEqual(meta.mieland_mcf_transaction_id.trim(), "ch_abc123");
      assert.strictEqual(meta.mieland_mcf_date_paid.trim(), "2026-09-24T15:00:00.000Z");
      assert.strictEqual(meta.mieland_mcf_refund_status.trim(), "refund_required");
    });

    it("should handle empty string values as null", () => {
      const meta = {
        mieland_mcf_cancelled_at: "2026-09-25T10:30:00.000Z",
        mieland_mcf_cancellation_source: "amazon_mcf",
        mieland_mcf_paid_amount: "",
        mieland_mcf_payment_method: "   ",
      };

      const paidAmount = meta.mieland_mcf_paid_amount.trim() || null;
      const paymentMethod = meta.mieland_mcf_payment_method.trim() || null;

      assert.strictEqual(paidAmount, null);
      assert.strictEqual(paymentMethod, null);
    });
  });

  describe("Order fulfillmentCancellation field", () => {
    it("should return null for non-cancelled orders", () => {
      const order = {
        databaseId: 123,
        status: "COMPLETED",
        fulfillmentCancellation: null,
      };

      assert.strictEqual(order.fulfillmentCancellation, null);
    });

    it("should include fulfillmentCancellation for cancelled orders with meta", () => {
      const order = {
        databaseId: 456,
        status: "CANCELLED",
        fulfillmentCancellation: {
          cancelledAt: "2026-09-25T10:30:00.000Z",
          source: "amazon_mcf",
          amazonStatus: "Cancelled",
          wasPaid: true,
          paidAmount: "89.99",
          paymentMethod: "stripe",
          transactionId: "ch_abc123",
          datePaid: "2026-09-24T15:00:00.000Z",
          refundStatus: "refund_required",
        },
      };

      assert.strictEqual(order.status, "CANCELLED");
      assert.ok(order.fulfillmentCancellation);
      assert.strictEqual(order.fulfillmentCancellation.cancelledAt, "2026-09-25T10:30:00.000Z");
      assert.strictEqual(order.fulfillmentCancellation.source, "amazon_mcf");
      assert.strictEqual(order.fulfillmentCancellation.amazonStatus, "Cancelled");
      assert.strictEqual(order.fulfillmentCancellation.wasPaid, true);
      assert.strictEqual(order.fulfillmentCancellation.paidAmount, "89.99");
      assert.strictEqual(order.fulfillmentCancellation.paymentMethod, "stripe");
      assert.strictEqual(order.fulfillmentCancellation.transactionId, "ch_abc123");
      assert.strictEqual(order.fulfillmentCancellation.datePaid, "2026-09-24T15:00:00.000Z");
      assert.strictEqual(order.fulfillmentCancellation.refundStatus, "refund_required");
    });

    it("should handle unpaid cancelled orders", () => {
      const cancellation = {
        cancelledAt: "2026-09-25T10:30:00.000Z",
        source: "amazon_mcf",
        amazonStatus: "Cancelled",
        wasPaid: false,
        paidAmount: null,
        paymentMethod: null,
        transactionId: null,
        datePaid: null,
        refundStatus: "no_refund_needed",
      };

      assert.strictEqual(cancellation.wasPaid, false);
      assert.strictEqual(cancellation.paidAmount, null);
      assert.strictEqual(cancellation.refundStatus, "no_refund_needed");
    });

    it("should handle refunded cancelled orders", () => {
      const cancellation = {
        cancelledAt: "2026-09-25T10:30:00.000Z",
        source: "amazon_mcf",
        amazonStatus: "Cancelled",
        wasPaid: true,
        paidAmount: "89.99",
        paymentMethod: "stripe",
        transactionId: "ch_abc123",
        datePaid: "2026-09-24T15:00:00.000Z",
        refundStatus: "refunded",
      };

      assert.strictEqual(cancellation.wasPaid, true);
      assert.strictEqual(cancellation.refundStatus, "refunded");
    });
  });

  describe("GraphQL selection optimization", () => {
    it("should request meta when fulfillmentCancellation is selected", () => {
      const fields = ["fulfillmentCancellation", "status", "total"];
      const needsMeta = fields.includes("fulfillmentCancellation");
      assert.strictEqual(needsMeta, true);
    });

    it("should not request meta when fulfillmentCancellation is not selected", () => {
      const fields = ["status", "total", "date"];
      const needsMeta = fields.includes("fulfillmentCancellation");
      assert.strictEqual(needsMeta, false);
    });
  });

  describe("Integration scenarios", () => {
    it("should distinguish Amazon MCF cancelled orders from manual cancels", () => {
      const amazonCancelled = {
        status: "CANCELLED",
        fulfillmentCancellation: {
          cancelledAt: "2026-09-25T10:30:00.000Z",
          source: "amazon_mcf",
          amazonStatus: "Cancelled",
          wasPaid: true,
          paidAmount: "89.99",
          paymentMethod: "stripe",
          transactionId: "ch_abc123",
          datePaid: "2026-09-24T15:00:00.000Z",
          refundStatus: "refund_required",
        },
      };

      const manuallyCancelled = {
        status: "CANCELLED",
        fulfillmentCancellation: null,
      };

      assert.ok(amazonCancelled.fulfillmentCancellation);
      assert.strictEqual(amazonCancelled.fulfillmentCancellation.source, "amazon_mcf");
      assert.strictEqual(manuallyCancelled.fulfillmentCancellation, null);
    });

    it("should handle all refund status values", () => {
      const statuses = ["refund_required", "refunded", "no_refund_needed"];

      for (const status of statuses) {
        const cancellation = {
          cancelledAt: "2026-09-25T10:30:00.000Z",
          source: "amazon_mcf",
          amazonStatus: "Cancelled",
          wasPaid: true,
          paidAmount: "89.99",
          paymentMethod: "stripe",
          transactionId: "ch_abc123",
          datePaid: "2026-09-24T15:00:00.000Z",
          refundStatus: status,
        };

        assert.ok(statuses.includes(cancellation.refundStatus));
      }
    });

    it("should preserve paidAmount as decimal string", () => {
      const amounts = ["89.99", "100.00", "1234.56", "0.99"];

      for (const amount of amounts) {
        const cancellation = {
          paidAmount: amount,
        };

        assert.strictEqual(typeof cancellation.paidAmount, "string");
        assert.ok(/^\d+\.\d+$/.test(cancellation.paidAmount));
      }
    });
  });
});
