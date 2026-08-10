import { query, queryOne, t } from "../db/mysql.js";
import { getProductNodes, getAttachmentUrl, getPostMeta } from "./products.js";
import { toGlobalId } from "../utils/index.js";
import type { OrderListNeeds } from "../utils/selection.js";
import {
  fetchOrderMcfTra,
  fetchMcfTraUpdates,
  type McfTraPackage,
  type McfTraUpdatesResponse,
} from "../clients/mieland-wp-bridge.js";

type HposOrder = {
  id: number;
  status: string;
  currency: string;
  total_amount: string;
  tax_amount: string;
  customer_id: number;
  payment_method: string;
  payment_method_title: string;
  transaction_id: string;
  date_created_gmt: Date | string;
  customer_note: string;
};

type AmazonMcfTracking = {
  trackingNumber: string | null;
  trackingUrl: string | null;
  carrier: string | null;
  status: string | null;
  estimatedArrival: string | null;
  sentToFbaAt: string | null;
  traNumber: string | null;
};

type McfFields = {
  amazonMcfTrackingCode: string | null;
  amazonMcfTracking: AmazonMcfTracking | null;
  amazonMcfTraNumber: string | null;
};

function money(v: unknown): string {
  const n = Number(v ?? 0);
  return n.toFixed(2);
}

function statusGql(status: string): string {
  const s = status.replace(/^wc-/, "");
  return s.toUpperCase();
}

function formatDate(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return value.toISOString?.() ?? String(value);
}

async function orderMeta(orderId: number): Promise<Record<string, string>> {
  const rows = await query<{ meta_key: string; meta_value: string }[]>(
    `SELECT meta_key, meta_value FROM ${t("wc_orders_meta")} WHERE order_id = ?`,
    [orderId],
  );
  return Object.fromEntries(rows.map((r) => [r.meta_key, r.meta_value ?? ""]));
}

async function orderMetaMany(
  orderIds: number[],
): Promise<Map<number, Record<string, string>>> {
  const out = new Map<number, Record<string, string>>();
  for (const id of orderIds) out.set(id, {});
  if (!orderIds.length) return out;
  const placeholders = orderIds.map(() => "?").join(",");
  const rows = await query<
    { order_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT order_id, meta_key, meta_value FROM ${t("wc_orders_meta")}
     WHERE order_id IN (${placeholders})`,
    orderIds,
  );
  for (const row of rows) {
    const bag = out.get(Number(row.order_id)) ?? {};
    bag[row.meta_key] = row.meta_value ?? "";
    out.set(Number(row.order_id), bag);
  }
  return out;
}

function mapAddress(row: Record<string, string> | null) {
  if (!row) return null;
  return {
    firstName: row.first_name ?? "",
    lastName: row.last_name ?? "",
    company: row.company ?? "",
    address1: row.address_1 ?? "",
    address2: row.address_2 ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    postcode: row.postcode ?? "",
    country: row.country ?? "",
    phone: row.phone ?? "",
    email: row.email ?? "",
  };
}

async function orderAddress(
  orderId: number,
  type: "billing" | "shipping",
) {
  const row = await queryOne<Record<string, string>>(
    `SELECT * FROM ${t("wc_order_addresses")} WHERE order_id = ? AND address_type = ? LIMIT 1`,
    [orderId, type],
  );
  return mapAddress(row);
}

async function orderAddressesMany(orderIds: number[]) {
  const billing = new Map<number, ReturnType<typeof mapAddress>>();
  const shipping = new Map<number, ReturnType<typeof mapAddress>>();
  if (!orderIds.length) return { billing, shipping };
  const placeholders = orderIds.map(() => "?").join(",");
  const rows = await query<Record<string, string>[]>(
    `SELECT * FROM ${t("wc_order_addresses")}
     WHERE order_id IN (${placeholders})`,
    orderIds,
  );
  for (const row of rows) {
    const id = Number(row.order_id);
    const mapped = mapAddress(row);
    if (row.address_type === "billing") billing.set(id, mapped);
    else if (row.address_type === "shipping") shipping.set(id, mapped);
  }
  return { billing, shipping };
}

async function itemMetaMany(itemIds: number[]) {
  const out = new Map<number, Record<string, string>>();
  for (const id of itemIds) out.set(id, {});
  if (!itemIds.length) return out;
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = await query<
    { order_item_id: number; meta_key: string; meta_value: string }[]
  >(
    `SELECT order_item_id, meta_key, meta_value
     FROM ${t("woocommerce_order_itemmeta")}
     WHERE order_item_id IN (${placeholders})`,
    itemIds,
  );
  for (const row of rows) {
    const bag = out.get(Number(row.order_item_id)) ?? {};
    bag[row.meta_key] = row.meta_value ?? "";
    out.set(Number(row.order_item_id), bag);
  }
  return out;
}

async function orderLines(orderId: number, withProducts: boolean) {
  const items = await query<
    { order_item_id: number; order_item_name: string; order_item_type: string }[]
  >(
    `SELECT order_item_id, order_item_name, order_item_type
     FROM ${t("woocommerce_order_items")}
     WHERE order_id = ? AND order_item_type = 'line_item'`,
    [orderId],
  );
  if (!items.length) return { nodes: [] };

  const metaMap = await itemMetaMany(items.map((i) => i.order_item_id));
  let productById = new Map<number, unknown>();
  if (withProducts) {
    const productIds: number[] = [];
    for (const item of items) {
      const meta = metaMap.get(item.order_item_id) ?? {};
      const productId = Number(meta._product_id || 0);
      const variationId = Number(meta._variation_id || 0);
      if (productId) productIds.push(productId);
      if (variationId) productIds.push(variationId);
    }
    const products = await getProductNodes(productIds);
    for (let i = 0; i < productIds.length; i++) {
      if (products[i]) productById.set(productIds[i], products[i]);
    }
  }

  const nodes = items.map((item) => {
    const meta = metaMap.get(item.order_item_id) ?? {};
    const productId = Number(meta._product_id || 0);
    const variationId = Number(meta._variation_id || 0);
    const product = withProducts && productId ? productById.get(productId) : null;
    const variation =
      withProducts && variationId ? productById.get(variationId) : null;
    return {
      databaseId: item.order_item_id,
      productId,
      quantity: Number(meta._qty || 1),
      subtotal: money(meta._line_subtotal),
      total: money(meta._line_total),
      product: product ? { node: product } : null,
      variation: variation ? { node: variation } : null,
    };
  });
  return { nodes };
}

async function orderLinesMany(orderIds: number[], withProducts: boolean) {
  const byOrder = new Map<number, unknown[]>();
  for (const id of orderIds) byOrder.set(id, []);
  if (!orderIds.length) return byOrder;

  const placeholders = orderIds.map(() => "?").join(",");
  const items = await query<
    {
      order_id: number;
      order_item_id: number;
      order_item_name: string;
    }[]
  >(
    `SELECT order_id, order_item_id, order_item_name
     FROM ${t("woocommerce_order_items")}
     WHERE order_id IN (${placeholders}) AND order_item_type = 'line_item'`,
    orderIds,
  );
  const metaMap = await itemMetaMany(items.map((i) => i.order_item_id));

  let productById = new Map<number, unknown>();
  if (withProducts) {
    const productIds: number[] = [];
    for (const item of items) {
      const meta = metaMap.get(item.order_item_id) ?? {};
      const productId = Number(meta._product_id || 0);
      const variationId = Number(meta._variation_id || 0);
      if (productId) productIds.push(productId);
      if (variationId) productIds.push(variationId);
    }
    const unique = [...new Set(productIds)];
    const products = await getProductNodes(unique);
    productById = new Map();
    for (let i = 0; i < unique.length; i++) {
      if (products[i]) productById.set(unique[i], products[i]);
    }
  }

  for (const item of items) {
    const meta = metaMap.get(item.order_item_id) ?? {};
    const productId = Number(meta._product_id || 0);
    const variationId = Number(meta._variation_id || 0);
    const product = withProducts && productId ? productById.get(productId) : null;
    const variation =
      withProducts && variationId ? productById.get(variationId) : null;
    const list = byOrder.get(Number(item.order_id)) ?? [];
    list.push({
      databaseId: item.order_item_id,
      productId,
      quantity: Number(meta._qty || 1),
      subtotal: money(meta._line_subtotal),
      total: money(meta._line_total),
      product: product ? { node: product } : null,
      variation: variation ? { node: variation } : null,
    });
    byOrder.set(Number(item.order_id), list);
  }
  return byOrder;
}

async function orderItemLinesMany(
  orderIds: number[],
  itemType: "shipping" | "tax" | "coupon",
) {
  const byOrder = new Map<number, unknown[]>();
  for (const id of orderIds) byOrder.set(id, []);
  if (!orderIds.length) return byOrder;

  const placeholders = orderIds.map(() => "?").join(",");
  const items = await query<
    { order_id: number; order_item_id: number; order_item_name: string }[]
  >(
    `SELECT order_id, order_item_id, order_item_name
     FROM ${t("woocommerce_order_items")}
     WHERE order_id IN (${placeholders}) AND order_item_type = ?`,
    [...orderIds, itemType],
  );
  const metaMap = await itemMetaMany(items.map((i) => i.order_item_id));
  for (const item of items) {
    const meta = metaMap.get(item.order_item_id) ?? {};
    const list = byOrder.get(Number(item.order_id)) ?? [];
    if (itemType === "shipping") {
      list.push({
        methodTitle: item.order_item_name,
        total: money(meta.cost ?? meta.total),
      });
    } else if (itemType === "tax") {
      list.push({
        label: item.order_item_name,
        taxTotal: money(meta.tax_amount ?? meta.total),
      });
    } else {
      list.push({
        code: item.order_item_name,
        discount: money(meta.discount_amount),
        discountTax: money(meta.discount_amount_tax),
      });
    }
    byOrder.set(Number(item.order_id), list);
  }
  return byOrder;
}

async function shippingLines(orderId: number) {
  const map = await orderItemLinesMany([orderId], "shipping");
  return { nodes: map.get(orderId) ?? [] };
}

async function taxLines(orderId: number) {
  const map = await orderItemLinesMany([orderId], "tax");
  return { nodes: map.get(orderId) ?? [] };
}

async function couponLines(orderId: number) {
  const map = await orderItemLinesMany([orderId], "coupon");
  return { nodes: map.get(orderId) ?? [] };
}

function parseMcf(meta: Record<string, string>): McfFields {
  // Prefer MCF plugin / TRA mu-plugin keys; keep legacy aliases as fallback.
  const trackingNumber =
    meta._ns_fba_shipment_tracking_number ||
    meta._amazon_mcf_tracking_code ||
    meta.amazon_mcf_tracking_code ||
    null;
  const trackingUrl = meta._ns_fba_shipment_tracking_url || null;
  const carrier = meta._ns_fba_shipment_carrier || null;
  const status = meta._fba_shipment_status || null;
  const estimatedArrival = meta._ns_fba_shipment_eta || null;
  const sentToFbaAt = meta._sent_to_fba || null;
  const traNumber =
    meta._ns_fba_amazon_fulfillment_tracking_number || null;

  const raw = meta._amazon_mcf_tracking || meta.amazon_mcf_tracking;
  let tracking: AmazonMcfTracking | null = null;

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<AmazonMcfTracking>;
      tracking = {
        trackingNumber: parsed.trackingNumber ?? trackingNumber,
        trackingUrl: parsed.trackingUrl ?? trackingUrl,
        carrier: parsed.carrier ?? carrier,
        status: parsed.status ?? status,
        estimatedArrival: parsed.estimatedArrival ?? estimatedArrival,
        sentToFbaAt: parsed.sentToFbaAt ?? sentToFbaAt,
        traNumber: parsed.traNumber ?? traNumber,
      };
    } catch {
      tracking = {
        trackingNumber: raw,
        trackingUrl,
        carrier,
        status,
        estimatedArrival,
        sentToFbaAt,
        traNumber,
      };
    }
  } else if (
    trackingNumber ||
    trackingUrl ||
    carrier ||
    status ||
    estimatedArrival ||
    sentToFbaAt ||
    traNumber
  ) {
    tracking = {
      trackingNumber,
      trackingUrl,
      carrier,
      status,
      estimatedArrival,
      sentToFbaAt,
      traNumber,
    };
  }

  return {
    amazonMcfTrackingCode: tracking?.trackingNumber ?? trackingNumber,
    amazonMcfTracking: tracking,
    amazonMcfTraNumber: tracking?.traNumber ?? traNumber,
  };
}

function mcfFromTraPackages(
  packages: McfTraPackage[],
  traNumber: string | null,
  sentToFbaAt: string | null,
): AmazonMcfTracking | null {
  const primary = packages.find((p) => p.traNumber || p.trackingNumber) ?? packages[0];
  if (!primary && !traNumber && !sentToFbaAt) return null;
  return {
    trackingNumber: primary?.trackingNumber ?? null,
    trackingUrl: primary?.customerTrackingLink ?? null,
    carrier: primary?.carrierCode ?? null,
    status: primary?.status ?? null,
    estimatedArrival: primary?.estimatedArrival ?? null,
    sentToFbaAt,
    traNumber: traNumber ?? primary?.traNumber ?? null,
  };
}

/**
 * When TRA / carrier tracking is missing but the order was sent to FBA,
 * refresh via WP bridge (Amazon GetFulfillmentOrder through the MCF plugin).
 */
async function enrichMcfFromBridge(
  orderId: number,
  mcf: McfFields,
  meta: Record<string, string>,
): Promise<McfFields> {
  const sentToFba = Boolean(meta._sent_to_fba);
  const hasTra = Boolean(mcf.amazonMcfTraNumber);
  const hasCarrier = Boolean(mcf.amazonMcfTracking?.trackingNumber);
  if (!sentToFba || (hasTra && hasCarrier)) return mcf;

  const live = await fetchOrderMcfTra(orderId, { refresh: true });
  if (!live) return mcf;

  const tracking =
    mcfFromTraPackages(live.packages ?? [], live.traNumber, meta._sent_to_fba || null) ??
    mcf.amazonMcfTracking;

  if (tracking && mcf.amazonMcfTracking) {
    tracking.trackingNumber =
      tracking.trackingNumber ?? mcf.amazonMcfTracking.trackingNumber;
    tracking.trackingUrl =
      tracking.trackingUrl ?? mcf.amazonMcfTracking.trackingUrl;
    tracking.carrier = tracking.carrier ?? mcf.amazonMcfTracking.carrier;
    tracking.status = tracking.status ?? mcf.amazonMcfTracking.status;
    tracking.estimatedArrival =
      tracking.estimatedArrival ?? mcf.amazonMcfTracking.estimatedArrival;
    tracking.sentToFbaAt =
      tracking.sentToFbaAt ?? mcf.amazonMcfTracking.sentToFbaAt;
    tracking.traNumber = tracking.traNumber ?? mcf.amazonMcfTracking.traNumber;
  }

  return {
    amazonMcfTrackingCode:
      tracking?.trackingNumber ?? mcf.amazonMcfTrackingCode,
    amazonMcfTracking: tracking,
    amazonMcfTraNumber: live.traNumber ?? tracking?.traNumber ?? mcf.amazonMcfTraNumber,
  };
}

function leanOrderNode(row: {
  id: number;
  status: string;
  currency: string;
  total_amount: string;
  tax_amount: string;
  payment_method: string;
  payment_method_title: string;
  transaction_id: string;
  date_created_gmt: Date | string;
  shipping_total_amount?: string | null;
  date_paid_gmt?: Date | string | null;
  order_key?: string | null;
}) {
  const shippingTotal = money(row.shipping_total_amount);
  const subtotalNum =
    Number(row.total_amount) -
    Number(row.shipping_total_amount ?? 0) -
    Number(row.tax_amount ?? 0);
  return {
    id: toGlobalId("order", row.id),
    databaseId: row.id,
    orderNumber: String(row.id),
    orderKey: row.order_key || "",
    status: statusGql(row.status),
    currency: row.currency,
    date: formatDate(row.date_created_gmt),
    datePaid: formatDate(row.date_paid_gmt),
    total: money(row.total_amount),
    subtotal: money(Math.max(0, subtotalNum)),
    shippingTotal,
    totalTax: money(row.tax_amount),
    paymentMethod: row.payment_method,
    paymentMethodTitle: row.payment_method_title,
    transactionId: row.transaction_id || "",
    needsPayment: ["pending", "on-hold", "failed"].includes(
      row.status.replace(/^wc-/, ""),
    ),
    amazonMcfTrackingCode: null as string | null,
    amazonMcfTracking: null as unknown,
    amazonMcfTraNumber: null as string | null,
    billing: null as ReturnType<typeof mapAddress>,
    shipping: null as ReturnType<typeof mapAddress>,
    lineItems: { nodes: [] as unknown[] },
    shippingLines: { nodes: [] as unknown[] },
    taxLines: { nodes: [] as unknown[] },
    couponLines: { nodes: [] as unknown[] },
  };
}

/** Fast list: one JOIN query + optional batched extras. Does not call shapeOrder. */
export async function listCustomerOrders(
  customerId: number,
  needs: OrderListNeeds = {
    addresses: false,
    lineItems: false,
    lineProducts: false,
    shippingLines: false,
    taxLines: false,
    couponLines: false,
    meta: false,
    refreshMcf: false,
  },
) {
  const rows = await query<
    {
      id: number;
      status: string;
      currency: string;
      total_amount: string;
      tax_amount: string;
      payment_method: string;
      payment_method_title: string;
      transaction_id: string;
      date_created_gmt: Date | string;
      shipping_total_amount: string | null;
      date_paid_gmt: Date | string | null;
      order_key: string | null;
    }[]
  >(
    `SELECT o.id, o.status, o.currency, o.total_amount, o.tax_amount,
            o.payment_method, o.payment_method_title, o.transaction_id,
            o.date_created_gmt,
            ops.shipping_total_amount, ops.date_paid_gmt, ops.order_key
     FROM ${t("wc_orders")} o
     LEFT JOIN ${t("wc_order_operational_data")} ops ON ops.order_id = o.id
     WHERE o.customer_id = ? AND o.type = 'shop_order'
     ORDER BY o.date_created_gmt DESC
     LIMIT 50`,
    [customerId],
  );

  const nodes = rows.map((row) => leanOrderNode(row));
  if (!nodes.length) return { nodes };

  const ids = nodes.map((n) => n.databaseId);
  const heavy =
    needs.addresses ||
    needs.lineItems ||
    needs.shippingLines ||
    needs.taxLines ||
    needs.couponLines ||
    needs.meta;

  if (!heavy) return { nodes };

  const [addresses, lineItems, shipping, taxes, coupons, metaMap] = await Promise.all([
    needs.addresses
      ? orderAddressesMany(ids)
      : Promise.resolve({
          billing: new Map(),
          shipping: new Map(),
        }),
    needs.lineItems
      ? orderLinesMany(ids, needs.lineProducts)
      : Promise.resolve(new Map<number, unknown[]>()),
    needs.shippingLines
      ? orderItemLinesMany(ids, "shipping")
      : Promise.resolve(new Map<number, unknown[]>()),
    needs.taxLines
      ? orderItemLinesMany(ids, "tax")
      : Promise.resolve(new Map<number, unknown[]>()),
    needs.couponLines
      ? orderItemLinesMany(ids, "coupon")
      : Promise.resolve(new Map<number, unknown[]>()),
    needs.meta
      ? orderMetaMany(ids)
      : Promise.resolve(new Map<number, Record<string, string>>()),
  ]);

  for (const node of nodes) {
    if (needs.addresses) {
      node.billing = addresses.billing.get(node.databaseId) ?? null;
      node.shipping = addresses.shipping.get(node.databaseId) ?? null;
    }
    if (needs.lineItems) {
      node.lineItems = { nodes: lineItems.get(node.databaseId) ?? [] };
    }
    if (needs.shippingLines) {
      node.shippingLines = { nodes: shipping.get(node.databaseId) ?? [] };
    }
    if (needs.taxLines) {
      node.taxLines = { nodes: taxes.get(node.databaseId) ?? [] };
    }
    if (needs.couponLines) {
      node.couponLines = { nodes: coupons.get(node.databaseId) ?? [] };
    }
    if (needs.meta) {
      const meta = metaMap.get(node.databaseId) ?? {};
      const mcf = parseMcf(meta);
      node.amazonMcfTrackingCode = mcf.amazonMcfTrackingCode;
      node.amazonMcfTracking = mcf.amazonMcfTracking;
      node.amazonMcfTraNumber = mcf.amazonMcfTraNumber;
      if (!node.transactionId) {
        node.transactionId = meta._transaction_id || "";
      }
      if (!node.orderKey) {
        node.orderKey = meta._order_key || "";
      }
    }
  }

  return { nodes };
}

/** Detail view — hydrate only what the GraphQL selection needs. */
export async function shapeOrder(
  orderId: number,
  needs: OrderListNeeds = {
    addresses: true,
    lineItems: true,
    lineProducts: true,
    shippingLines: true,
    taxLines: true,
    couponLines: true,
    meta: true,
    refreshMcf: true,
  },
) {
  const order = await queryOne<HposOrder>(
    `SELECT id, status, currency, total_amount, tax_amount, customer_id,
            payment_method, payment_method_title, transaction_id,
            date_created_gmt, customer_note
     FROM ${t("wc_orders")} WHERE id = ? LIMIT 1`,
    [orderId],
  );
  if (!order) return null;

  const [ops, meta] = await Promise.all([
    queryOne<{
      shipping_total_amount: string;
      discount_total_amount: string;
      date_paid_gmt: Date | string | null;
      order_key: string | null;
    }>(
      `SELECT shipping_total_amount, discount_total_amount, date_paid_gmt, order_key
       FROM ${t("wc_order_operational_data")} WHERE order_id = ? LIMIT 1`,
      [orderId],
    ),
    needs.meta ? orderMeta(orderId) : Promise.resolve({} as Record<string, string>),
  ]);
  const mcfCached = needs.meta
    ? parseMcf(meta)
    : {
        amazonMcfTrackingCode: null as string | null,
        amazonMcfTracking: null as AmazonMcfTracking | null,
        amazonMcfTraNumber: null as string | null,
      };
  const mcf =
    needs.meta && needs.refreshMcf
      ? await enrichMcfFromBridge(orderId, mcfCached, meta)
      : mcfCached;

  const subtotalNum =
    Number(order.total_amount) -
    Number(ops?.shipping_total_amount ?? 0) -
    Number(order.tax_amount ?? 0);

  const [billing, shipping, lineItems, shippingLineNodes, taxLineNodes, couponLineNodes] =
    await Promise.all([
      needs.addresses ? orderAddress(order.id, "billing") : Promise.resolve(null),
      needs.addresses ? orderAddress(order.id, "shipping") : Promise.resolve(null),
      needs.lineItems
        ? orderLines(order.id, needs.lineProducts)
        : Promise.resolve({ nodes: [] as unknown[] }),
      needs.shippingLines
        ? shippingLines(order.id)
        : Promise.resolve({ nodes: [] as unknown[] }),
      needs.taxLines
        ? taxLines(order.id)
        : Promise.resolve({ nodes: [] as unknown[] }),
      needs.couponLines
        ? couponLines(order.id)
        : Promise.resolve({ nodes: [] as unknown[] }),
    ]);

  return {
    id: toGlobalId("order", order.id),
    databaseId: order.id,
    orderNumber: String(order.id),
    orderKey: ops?.order_key || meta._order_key || "",
    status: statusGql(order.status),
    currency: order.currency,
    date: formatDate(order.date_created_gmt),
    datePaid: formatDate(ops?.date_paid_gmt),
    total: money(order.total_amount),
    subtotal: money(Math.max(0, subtotalNum)),
    shippingTotal: money(ops?.shipping_total_amount),
    totalTax: money(order.tax_amount),
    paymentMethod: order.payment_method,
    paymentMethodTitle: order.payment_method_title,
    transactionId: order.transaction_id || meta._transaction_id || "",
    needsPayment: ["pending", "on-hold", "failed"].includes(
      order.status.replace(/^wc-/, ""),
    ),
    ...mcf,
    billing,
    shipping,
    lineItems,
    shippingLines: shippingLineNodes,
    taxLines: taxLineNodes,
    couponLines: couponLineNodes,
  };
}

/** Map a fresh WC REST order create response — no MySQL (lean checkout path). */
export function shapeOrderFromWc(wc: Record<string, unknown>) {
  const id = Number(wc.id);
  const status = String(wc.status ?? "pending");
  const total = money(wc.total);
  const shippingTotal = money(wc.shipping_total);
  const totalTax = money(wc.total_tax);
  const subtotalNum = Number(wc.total ?? 0) - Number(wc.shipping_total ?? 0) - Number(wc.total_tax ?? 0);
  const couponLineNodes = Array.isArray(wc.coupon_lines)
    ? wc.coupon_lines.map((line) => {
        const row = line as Record<string, unknown>;
        return {
          code: String(row.code ?? ""),
          discount: money(row.discount),
          discountTax: money(row.discount_tax),
        };
      })
    : [];
  return {
    id: toGlobalId("order", id),
    databaseId: id,
    orderNumber: String(wc.number ?? id),
    orderKey: String(wc.order_key ?? ""),
    status: statusGql(status),
    currency: String(wc.currency ?? ""),
    date: formatDate((wc.date_created_gmt as string) ?? null),
    datePaid: formatDate((wc.date_paid_gmt as string) ?? null),
    total,
    subtotal: money(Math.max(0, subtotalNum)),
    shippingTotal,
    totalTax,
    paymentMethod: String(wc.payment_method ?? ""),
    paymentMethodTitle: String(wc.payment_method_title ?? ""),
    transactionId: String(wc.transaction_id ?? ""),
    needsPayment: ["pending", "on-hold", "failed"].includes(
      status.replace(/^wc-/, ""),
    ),
    amazonMcfTrackingCode: null as string | null,
    amazonMcfTracking: null as unknown,
    amazonMcfTraNumber: null as string | null,
    billing: null,
    shipping: null,
    lineItems: { nodes: [] as unknown[] },
    shippingLines: { nodes: [] as unknown[] },
    taxLines: { nodes: [] as unknown[] },
    couponLines: { nodes: couponLineNodes },
  };
}

export async function getOrderById(
  id: number,
  customerId?: number | null,
  needs?: OrderListNeeds,
) {
  const order = await shapeOrder(id, needs);
  if (!order) return null;
  if (customerId != null && order.databaseId) {
    const row = await queryOne<{ customer_id: number }>(
      `SELECT customer_id FROM ${t("wc_orders")} WHERE id = ?`,
      [id],
    );
    if (row && Number(row.customer_id) !== customerId) return null;
  }
  return order;
}

/**
 * Package tracking timeline for a TRA via WP bridge (getPackageTrackingDetails).
 * Defaults to the order's primary TRA when traNumber is omitted.
 */
export async function getOrderMcfTraUpdates(
  orderId: number,
  options: { traNumber?: string | null; refresh?: boolean } = {},
): Promise<McfTraUpdatesResponse | null> {
  let tra =
    options.traNumber?.trim() ||
    null;

  if (!tra) {
    const meta = await orderMeta(orderId);
    const mcf = parseMcf(meta);
    tra = mcf.amazonMcfTraNumber;
    if (!tra && meta._sent_to_fba) {
      const live = await fetchOrderMcfTra(orderId, {
        refresh: options.refresh !== false,
      });
      tra = live?.traNumber ?? null;
    }
  }

  if (!tra) {
    return {
      traNumber: "",
      orderId,
      packageNumber: null,
      available: false,
      trackingNumber: null,
      customerTrackingLink: null,
      carrierCode: null,
      currentStatus: null,
      currentStatusDescription: null,
      updates: [],
      source: "none",
      error: "tra_required",
    };
  }

  return fetchMcfTraUpdates(tra, {
    orderId,
    refresh: options.refresh !== false,
  });
}

/** Lean load for Store API checkout/{id} payment — key + addresses + ownership. */
export async function getOrderPaymentContext(orderId: number) {
  const order = await queryOne<{
    id: number;
    status: string;
    customer_id: number;
    payment_method: string;
    currency: string;
    total_amount: string;
  }>(
    `SELECT id, status, customer_id, payment_method, currency, total_amount
     FROM ${t("wc_orders")} WHERE id = ? AND type = 'shop_order' LIMIT 1`,
    [orderId],
  );
  if (!order) return null;

  const [ops, meta, billing, shipping] = await Promise.all([
    queryOne<{ order_key: string | null }>(
      `SELECT order_key FROM ${t("wc_order_operational_data")} WHERE order_id = ? LIMIT 1`,
      [orderId],
    ),
    orderMeta(orderId),
    orderAddress(orderId, "billing"),
    orderAddress(orderId, "shipping"),
  ]);

  const status = order.status.replace(/^wc-/, "");
  return {
    id: order.id,
    customerId: Number(order.customer_id),
    status,
    paymentMethod: order.payment_method || "stripe",
    currency: order.currency || "USD",
    total: money(order.total_amount),
    orderKey: ops?.order_key || meta._order_key || "",
    needsPayment: ["pending", "on-hold", "failed"].includes(status),
    billing,
    shipping,
  };
}

void getAttachmentUrl;
void getPostMeta;
