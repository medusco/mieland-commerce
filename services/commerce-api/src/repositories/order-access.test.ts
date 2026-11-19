import { describe, it } from "node:test";
import assert from "node:assert";
import {
  authorizeMarkOrderGa4Tracked,
  authorizeOrderByKey,
  ga4PurchaseTrackedFromMeta,
  ga4TrackedMarkWasNew,
  orderKeysEqual,
} from "./order-access.js";
import {
  isValidSubscriptionFrequency,
  subscriptionFrequencyFromItemMeta,
} from "./orders.js";

describe("orderKeysEqual", () => {
  it("matches identical keys", () => {
    assert.strictEqual(orderKeysEqual("wc_order_abc", "wc_order_abc"), true);
  });

  it("rejects mismatched keys", () => {
    assert.strictEqual(orderKeysEqual("wc_order_abc", "wc_order_xyz"), false);
  });

  it("rejects empty provided or stored key", () => {
    assert.strictEqual(orderKeysEqual("", "wc_order_abc"), false);
    assert.strictEqual(orderKeysEqual("wc_order_abc", ""), false);
    assert.strictEqual(orderKeysEqual("", ""), false);
  });

  it("rejects unequal lengths without throwing", () => {
    assert.strictEqual(orderKeysEqual("short", "much-longer-key"), false);
  });
});

describe("authorizeOrderByKey", () => {
  const guestBase = {
    orderKeyProvided: "wc_order_abc",
    orderKeyStored: "wc_order_abc",
    customerId: 0,
    userId: null as number | null,
  };

  it("allows guest when key matches", () => {
    assert.deepStrictEqual(authorizeOrderByKey(guestBase), { ok: true });
  });

  it("rejects empty key", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({ ...guestBase, orderKeyProvided: "  " }),
      { ok: false, reason: "empty_key" },
    );
  });

  it("rejects key mismatch", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({
        ...guestBase,
        orderKeyProvided: "wc_order_wrong",
      }),
      { ok: false, reason: "key_mismatch" },
    );
  });

  it("rejects billingEmail mismatch when provided", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({
        ...guestBase,
        billingEmailProvided: "wrong@example.com",
        billingEmailStored: "guest@example.com",
      }),
      { ok: false, reason: "billing_email_mismatch" },
    );
  });

  it("allows billingEmail match case-insensitively", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({
        ...guestBase,
        billingEmailProvided: "Guest@Example.COM",
        billingEmailStored: "guest@example.com",
      }),
      { ok: true },
    );
  });

  it("rejects customer order without JWT", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({
        ...guestBase,
        customerId: 42,
        userId: null,
      }),
      { ok: false, reason: "customer_auth_required" },
    );
  });

  it("rejects customer order with mismatched JWT", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({
        ...guestBase,
        customerId: 42,
        userId: 99,
      }),
      { ok: false, reason: "customer_mismatch" },
    );
  });

  it("allows customer order with matching JWT and key", () => {
    assert.deepStrictEqual(
      authorizeOrderByKey({
        ...guestBase,
        customerId: 42,
        userId: 42,
      }),
      { ok: true },
    );
  });
});

describe("authorizeMarkOrderGa4Tracked", () => {
  it("allows signed-in owner without orderKey", () => {
    assert.deepStrictEqual(
      authorizeMarkOrderGa4Tracked({
        customerId: 7,
        userId: 7,
        orderKeyStored: "wc_order_abc",
      }),
      { ok: true },
    );
  });

  it("rejects customer order without matching JWT even with key", () => {
    assert.deepStrictEqual(
      authorizeMarkOrderGa4Tracked({
        customerId: 7,
        userId: null,
        orderKeyProvided: "wc_order_abc",
        orderKeyStored: "wc_order_abc",
      }),
      { ok: false, reason: "customer_auth_required" },
    );
  });

  it("allows guest with exact orderKey", () => {
    assert.deepStrictEqual(
      authorizeMarkOrderGa4Tracked({
        customerId: 0,
        userId: null,
        orderKeyProvided: "wc_order_abc",
        orderKeyStored: "wc_order_abc",
      }),
      { ok: true },
    );
  });

  it("rejects guest with key mismatch", () => {
    assert.deepStrictEqual(
      authorizeMarkOrderGa4Tracked({
        customerId: 0,
        userId: null,
        orderKeyProvided: "wc_order_wrong",
        orderKeyStored: "wc_order_abc",
      }),
      { ok: false, reason: "key_mismatch" },
    );
  });

  it("rejects guest with empty key", () => {
    assert.deepStrictEqual(
      authorizeMarkOrderGa4Tracked({
        customerId: 0,
        userId: null,
        orderKeyProvided: "",
        orderKeyStored: "wc_order_abc",
      }),
      { ok: false, reason: "empty_key" },
    );
  });
});

describe("ga4PurchaseTrackedFromMeta", () => {
  it("is true only when meta is non-empty", () => {
    assert.strictEqual(
      ga4PurchaseTrackedFromMeta({ _mieland_ga4_purchase_tracked: "1710000000" }),
      true,
    );
    assert.strictEqual(
      ga4PurchaseTrackedFromMeta({ _mieland_ga4_purchase_tracked: "" }),
      false,
    );
    assert.strictEqual(ga4PurchaseTrackedFromMeta({}), false);
  });
});

describe("subscriptionFrequencyFromItemMeta", () => {
  it("returns valid frequency", () => {
    assert.strictEqual(
      subscriptionFrequencyFromItemMeta({ _subscription_frequency: "monthly" }),
      "monthly",
    );
    assert.strictEqual(
      subscriptionFrequencyFromItemMeta({ subscription_frequency: "weekly" }),
      "weekly",
    );
  });

  it("returns null for invalid frequency", () => {
    assert.strictEqual(
      subscriptionFrequencyFromItemMeta({
        _subscription_frequency: "daily",
      }),
      null,
    );
    assert.strictEqual(isValidSubscriptionFrequency("daily"), false);
  });

  it("returns null when missing", () => {
    assert.strictEqual(subscriptionFrequencyFromItemMeta({}), null);
    assert.strictEqual(
      subscriptionFrequencyFromItemMeta({ _subscription_frequency: "" }),
      null,
    );
  });
});

describe("markOrderGa4Tracked affectedRows semantics", () => {
  it("returns true when newly marked", () => {
    assert.strictEqual(ga4TrackedMarkWasNew(1), true);
  });

  it("returns false when already tracked", () => {
    assert.strictEqual(ga4TrackedMarkWasNew(0), false);
  });
});
