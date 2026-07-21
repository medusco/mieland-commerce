/**
 * Smoke: health + catalog + full checkout path.
 *
 * Target (first match wins):
 *   npm run smoke -- --url https://api.example.com
 *   SMOKE_BASE_URL=https://api.example.com   (appends /graphql)
 *   GRAPHQL_URL=https://api.example.com/graphql
 *   default: http://127.0.0.1:4000/graphql
 *
 * Required for checkout steps:
 *   SMOKE_USERNAME / SMOKE_PASSWORD  — WP customer credentials
 *   API env consumerKey / consumerSecret — for placeOrder (on the server under test)
 *
 * Optional:
 *   SMOKE_PRODUCT_ID=<databaseId>
 *   SMOKE_SUBSCRIPTION_PRODUCT_ID=<databaseId>  — second product for subscription cart/checkout
 *   SMOKE_SUBSCRIPTION_FREQUENCY=monthly
 *   SMOKE_OOS_PRODUCT_ID=<databaseId>  — assert addToCart rejects out-of-stock
 *   SMOKE_OVERSTOCK_QTY=9              — assert addToCart rejects qty above stock
 *   SMOKE_SKIP_CHECKOUT=1
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function normalizeGraphqlUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) return "http://127.0.0.1:4000/graphql";
  if (/\/graphql$/i.test(trimmed)) return trimmed;
  return `${trimmed}/graphql`;
}

function resolveEndpoint(): string {
  const argvUrl = (() => {
    const i = process.argv.indexOf("--url");
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    const eq = process.argv.find((a) => a.startsWith("--url="));
    if (eq) return eq.slice("--url=".length);
    // bare URL arg: npm run smoke -- https://...
    const bare = process.argv.slice(2).find((a) => /^https?:\/\//i.test(a));
    return bare;
  })();

  const fromEnv =
    process.env.GRAPHQL_URL ||
    process.env.SMOKE_BASE_URL ||
    process.env.SMOKE_URL ||
    "";

  return normalizeGraphqlUrl(argvUrl || fromEnv || "http://127.0.0.1:4000/graphql");
}

const endpoint = resolveEndpoint();
const username = process.env.SMOKE_USERNAME || "";
const password = process.env.SMOKE_PASSWORD || "";
const skipCheckout = process.env.SMOKE_SKIP_CHECKOUT === "1";
const oosProductId = process.env.SMOKE_OOS_PRODUCT_ID
  ? Number(process.env.SMOKE_OOS_PRODUCT_ID)
  : null;
const overstockQty = Math.max(
  1,
  Number(process.env.SMOKE_OVERSTOCK_QTY || 9) || 9,
);
const subscriptionProductId = process.env.SMOKE_SUBSCRIPTION_PRODUCT_ID
  ? Number(process.env.SMOKE_SUBSCRIPTION_PRODUCT_ID)
  : null;
const subscriptionFrequency =
  process.env.SMOKE_SUBSCRIPTION_FREQUENCY?.trim() || "monthly";

const STOCK_STATUSES = new Set([
  "IN_STOCK",
  "OUT_OF_STOCK",
  "ON_BACKORDER",
  "INSTOCK",
  "OUTOFSTOCK",
  "ONBACKORDER",
]);

type GqlError = { message: string; extensions?: { code?: string } };
type GqlJson = { data?: Record<string, unknown> | null; errors?: GqlError[] };

type Session = {
  token: string | null;
  auth: string | null;
};

type Timing = { step: string; ms: number; ok: boolean };
const timings: Timing[] = [];

function recordTiming(step: string, ms: number, succeeded: boolean) {
  timings.push({ step, ms: Math.round(ms), ok: succeeded });
}

function fail(step: string, detail: unknown, ms?: number): never {
  if (ms != null) recordTiming(step, ms, false);
  const time = ms != null ? ` ${Math.round(ms)}ms` : "";
  console.error(`FAIL${time} ${step}`, detail);
  process.exitCode = 1;
  throw new Error(`${step} failed`);
}

function ok(step: string, detail?: unknown, ms?: number) {
  if (ms != null) recordTiming(step, ms, true);
  const time = ms != null ? ` ${Math.round(ms)}ms` : "";
  if (detail === undefined) console.log(`ok${time} ${step}`);
  else
    console.log(
      `ok${time} ${step}`,
      typeof detail === "string" ? detail : JSON.stringify(detail),
    );
}

function printTimingSummary() {
  if (!timings.length) return;
  const requests = timings.filter((t) => t.step !== "wall");
  const wall = timings.find((t) => t.step === "wall");
  const sum = requests.reduce((s, t) => s + t.ms, 0);
  const width = Math.max(...timings.map((t) => t.step.length), 8);
  console.log("\n--- timings ---");
  for (const t of requests) {
    const mark = t.ok ? " " : "!";
    console.log(`${mark} ${t.step.padEnd(width)}  ${String(t.ms).padStart(5)}ms`);
  }
  console.log(`  ${"sum".padEnd(width)}  ${String(sum).padStart(5)}ms`);
  if (wall) {
    console.log(`  ${"wall".padEnd(width)}  ${String(wall.ms).padStart(5)}ms`);
  }
}

async function gql(
  session: Session,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ status: number; json: GqlJson; ms: number }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (session.token) headers["woocommerce-session"] = `Session ${session.token}`;
  if (session.auth) headers.Authorization = `Bearer ${session.auth}`;

  const started = performance.now();
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });

  const rawSession = res.headers.get("woocommerce-session");
  const m = rawSession?.match(/^\s*Session\s+(\S+)\s*$/i);
  if (m) session.token = m[1];

  const json = (await res.json()) as GqlJson;
  return { status: res.status, json, ms: performance.now() - started };
}

async function mustGql<T>(
  session: Session,
  step: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data: T; ms: number }> {
  const { status, json, ms } = await gql(session, query, variables);
  if (status >= 500) fail(step, { status, json }, ms);
  if (json.errors?.length) fail(step, json.errors, ms);
  if (!json.data) fail(step, { message: "no data", json }, ms);
  return { data: json.data as T, ms };
}

async function main() {
  const session: Session = { token: null, auth: null };
  const smokeStarted = performance.now();
  console.log(`smoke target ${endpoint}`);

  {
    const started = performance.now();
    const health = await fetch(endpoint.replace(/\/graphql$/i, "/health"));
    const healthBody = await health.text();
    const ms = performance.now() - started;
    if (health.status !== 200) fail("health", { status: health.status, healthBody }, ms);
    ok("health", healthBody, ms);
  }

  // --- catalog ---
  type ProductNode = {
    databaseId: number;
    name: string;
    __typename?: string;
    price?: string | null;
    stockStatus?: string | null;
    stockQuantity?: number | null;
    manageStock?: boolean | null;
  };
  type ProductsData = {
    products: { nodes: Array<ProductNode | null> | null } | null;
  };
  const { data: productsData, ms: productsMs } = await mustGql<ProductsData>(
    session,
    "GetProducts",
    `query GetProducts($first: Int = 10) {
      products(first: $first, where: { status: "publish" }) {
        nodes {
          databaseId
          name
          __typename
          ... on SimpleProduct { price stockStatus stockQuantity manageStock }
          ... on VariableProduct { price stockStatus stockQuantity manageStock }
        }
      }
    }`,
  );
  const nodes = (productsData.products?.nodes ?? []).filter(
    (n): n is ProductNode => Boolean(n?.databaseId),
  );
  ok("GetProducts", { count: nodes.length }, productsMs);

  // --- stock levels ---
  const stockSummary = { inStock: 0, outOfStock: 0, other: 0, unknown: 0 };
  for (const n of nodes) {
    const status = (n.stockStatus ?? "").toUpperCase().replace(/-/g, "_");
    if (!status) {
      stockSummary.unknown += 1;
      continue;
    }
    if (!STOCK_STATUSES.has(status)) {
      fail("stockLevels", {
        message: `unexpected stockStatus`,
        productId: n.databaseId,
        stockStatus: n.stockStatus,
      });
    }
    if (status === "IN_STOCK" || status === "INSTOCK") stockSummary.inStock += 1;
    else if (status === "OUT_OF_STOCK" || status === "OUTOFSTOCK") {
      stockSummary.outOfStock += 1;
    } else stockSummary.other += 1;
  }
  if (stockSummary.unknown > 0) {
    fail("stockLevels", {
      message: "products missing stockStatus",
      ...stockSummary,
    });
  }
  ok("stockLevels", stockSummary);

  const forcedId = process.env.SMOKE_PRODUCT_ID
    ? Number(process.env.SMOKE_PRODUCT_ID)
    : null;
  const inStock = (n: ProductNode) => {
    const s = (n.stockStatus ?? "").toUpperCase().replace(/-/g, "_");
    return s === "IN_STOCK" || s === "INSTOCK" || s === "ON_BACKORDER" || s === "ONBACKORDER";
  };
  const product =
    (forcedId ? nodes.find((n) => n.databaseId === forcedId) : null) ??
    nodes.find((n) => n.__typename === "SimpleProduct" && inStock(n)) ??
    nodes.find((n) => inStock(n)) ??
    nodes[0];
  if (!product?.databaseId) fail("pickProduct", "no publish products");
  if (!inStock(product)) {
    fail("pickProduct", {
      message: "no in-stock product for cart smoke (set SMOKE_PRODUCT_ID)",
      stockStatus: product.stockStatus,
      databaseId: product.databaseId,
    });
  }
  ok("pickProduct", {
    databaseId: product.databaseId,
    name: product.name,
    stockStatus: product.stockStatus,
    stockQuantity: product.stockQuantity ?? null,
    manageStock: product.manageStock ?? false,
  });

  const forcedSubId =
    subscriptionProductId && Number.isFinite(subscriptionProductId)
      ? subscriptionProductId
      : null;
  const subProduct: ProductNode | null =
    (forcedSubId
      ? nodes.find((n) => n.databaseId === forcedSubId) ?? {
          databaseId: forcedSubId,
          name: `product ${forcedSubId}`,
          stockStatus: "IN_STOCK",
        }
      : null) ??
    nodes.find(
      (n) =>
        n.databaseId !== product.databaseId &&
        n.__typename === "SimpleProduct" &&
        inStock(n),
    ) ??
    nodes.find((n) => n.databaseId !== product.databaseId && inStock(n)) ??
    null;
  if (subProduct) {
    ok("pickSubscriptionProduct", {
      databaseId: subProduct.databaseId,
      name: subProduct.name,
      frequency: subscriptionFrequency,
    });
  } else {
    ok(
      "pickSubscriptionProduct",
      "skipped (need a second in-stock product or SMOKE_SUBSCRIPTION_PRODUCT_ID)",
    );
  }

  if (!username || !password) {
    fail(
      "credentials",
      "Set SMOKE_USERNAME and SMOKE_PASSWORD in .env for checkout smoke",
    );
  }

  // --- login ---
  type LoginData = {
    login: {
      authToken: string;
      sessionToken: string | null;
      customer: { id: string; databaseId: number; email: string } | null;
    } | null;
  };
  const { data: loginData, ms: loginMs } = await mustGql<LoginData>(
    session,
    "login",
    `mutation Login($input: LoginInput!) {
      login(input: $input) {
        authToken
        sessionToken
        customer { id databaseId email }
      }
    }`,
    {
      input: {
        provider: "PASSWORD",
        credentials: { username, password },
      },
    },
  );
  const authToken = loginData.login?.authToken;
  const customerId = loginData.login?.customer?.databaseId;
  const customerGid = loginData.login?.customer?.id;
  if (!authToken || !customerId || !customerGid) fail("login", loginData, loginMs);
  session.auth = authToken;
  if (loginData.login?.sessionToken) session.token = loginData.login.sessionToken;
  ok("login", { customerId, email: loginData.login?.customer?.email }, loginMs);

  type CartContents = {
    cart: {
      contents: {
        itemCount: number;
        nodes: Array<{
          key: string;
          quantity: number;
          subtotal?: string | null;
          extraData?: Array<{ key: string; value: string } | null> | null;
        } | null> | null;
      } | null;
    } | null;
  };
  const cartQuery = `query GetCart {
    cart {
      contents {
        itemCount
        nodes { key quantity }
      }
    }
  }`;
  const cartFields = `
    cart {
      contents {
        itemCount
        nodes { key quantity }
      }
    }
  `;
  const cartFieldsWithExtra = `
    cart {
      contents {
        itemCount
        nodes {
          key
          quantity
          subtotal
          extraData { key value }
        }
      }
    }
  `;

  const { data: cartAfterLogin, ms: cartLoginMs } = await mustGql<CartContents>(
    session,
    "getCart(afterLogin)",
    cartQuery,
  );
  ok(
    "getCart(afterLogin)",
    { itemCount: cartAfterLogin.cart?.contents?.itemCount ?? 0 },
    cartLoginMs,
  );

  // --- out-of-stock rejection ---
  const oosFromCatalog = nodes.find((n) => {
    const s = (n.stockStatus ?? "").toUpperCase().replace(/-/g, "_");
    return s === "OUT_OF_STOCK" || s === "OUTOFSTOCK";
  });
  const oosId =
    (oosProductId && Number.isFinite(oosProductId) ? oosProductId : null) ??
    oosFromCatalog?.databaseId ??
    null;
  if (oosId) {
    const { status, json, ms } = await gql(
      session,
      `mutation AddToCart($input: AddToCartInput!) {
        addToCart(input: $input) { ${cartFields} }
      }`,
      { input: { productId: oosId, quantity: 1 } },
    );
    const rejected = (json.errors ?? []).some((e) =>
      /out of stock/i.test(e.message),
    );
    if (status >= 500) fail("addToCart(oos)", { status, json }, ms);
    if (!rejected) {
      fail(
        "addToCart(oos)",
        {
          message: "expected out-of-stock error",
          productId: oosId,
          json,
        },
        ms,
      );
    }
    ok("addToCart(oos)", { productId: oosId, rejected: true }, ms);
  } else {
    ok("addToCart(oos)", "skipped (no OUT_OF_STOCK product; set SMOKE_OOS_PRODUCT_ID)");
  }

  // --- overstock rejection (qty above managed stock) ---
  const limited = nodes.find((n) => {
    if (!inStock(n) || !n.manageStock) return false;
    const qty = n.stockQuantity;
    return qty != null && Number.isFinite(qty) && qty < overstockQty;
  });
  const overTarget = limited ?? product;
  const tryQty = overstockQty;
  const expectReject =
    Boolean(overTarget.manageStock) &&
    overTarget.stockQuantity != null &&
    tryQty > Number(overTarget.stockQuantity);

  {
    const { status, json, ms } = await gql(
      session,
      `mutation AddToCart($input: AddToCartInput!) {
        addToCart(input: $input) { ${cartFields} }
      }`,
      { input: { productId: overTarget.databaseId, quantity: tryQty } },
    );
    const rejected = (json.errors ?? []).some((e) =>
      /out of stock|not enough stock/i.test(e.message),
    );
    if (status >= 500) fail("addToCart(overstock)", { status, json }, ms);

    if (expectReject) {
      if (!rejected) {
        fail(
          "addToCart(overstock)",
          {
            message: `expected stock rejection for qty ${tryQty}`,
            productId: overTarget.databaseId,
            stockQuantity: overTarget.stockQuantity,
            json,
          },
          ms,
        );
      }
      ok(
        "addToCart(overstock)",
        {
          productId: overTarget.databaseId,
          quantity: tryQty,
          stockQuantity: overTarget.stockQuantity,
          rejected: true,
        },
        ms,
      );
    } else if (rejected) {
      ok(
        "addToCart(overstock)",
        {
          productId: overTarget.databaseId,
          quantity: tryQty,
          rejected: true,
        },
        ms,
      );
    } else {
      // Stock not managed / sufficient — clear any items so later steps stay clean
      const keys = (json.data?.addToCart as CartContents | undefined)?.cart?.contents?.nodes
        ?.map((n) => n?.key)
        .filter((k): k is string => Boolean(k));
      if (keys?.length) {
        await gql(
          session,
          `mutation RemoveItems($input: RemoveItemsFromCartInput!) {
            removeItemsFromCart(input: $input) { ${cartFields} }
          }`,
          { input: { keys } },
        );
      }
      ok(
        "addToCart(overstock)",
        `skipped (qty ${tryQty} allowed; no managed stock < ${overstockQty})`,
        ms,
      );
    }
  }

  // --- addToCart ---
  const { data: added, ms: addMs } = await mustGql<{ addToCart: CartContents }>(
    session,
    "addToCart",
    `mutation AddToCart($input: AddToCartInput!) {
      addToCart(input: $input) { ${cartFields} }
    }`,
    { input: { productId: product.databaseId, quantity: 1 } },
  );
  const afterAdd = added.addToCart?.cart?.contents;
  const itemKey = afterAdd?.nodes?.find(Boolean)?.key;
  if (!itemKey || (afterAdd?.itemCount ?? 0) < 1) fail("addToCart", added, addMs);
  ok("addToCart", { itemCount: afterAdd?.itemCount, key: itemKey }, addMs);

  const { data: cartAfterAdd, ms: cartAddMs } = await mustGql<CartContents>(
    session,
    "getCart(afterAdd)",
    cartQuery,
  );
  ok(
    "getCart(afterAdd)",
    { itemCount: cartAfterAdd.cart?.contents?.itemCount ?? 0 },
    cartAddMs,
  );

  // --- updateQuantity ---
  const { data: updated, ms: updateMs } = await mustGql<{
    updateItemQuantities: CartContents;
  }>(
    session,
    "updateItemQuantities",
    `mutation UpdateQty($input: UpdateItemQuantitiesInput!) {
      updateItemQuantities(input: $input) { ${cartFields} }
    }`,
    { input: { items: [{ key: itemKey, quantity: 2 }] } },
  );
  const qty =
    updated.updateItemQuantities?.cart?.contents?.nodes?.find((n) => n?.key === itemKey)
      ?.quantity;
  if (qty !== 2) fail("updateItemQuantities", updated, updateMs);
  ok("updateItemQuantities", { quantity: qty }, updateMs);

  // --- removeFromCart ---
  const { data: removed, ms: removeMs } = await mustGql<{
    removeItemsFromCart: CartContents;
  }>(
    session,
    "removeItemsFromCart",
    `mutation Remove($input: RemoveItemsFromCartInput!) {
      removeItemsFromCart(input: $input) { ${cartFields} }
    }`,
    { input: { keys: [itemKey] } },
  );
  if ((removed.removeItemsFromCart?.cart?.contents?.itemCount ?? -1) !== 0) {
    fail("removeItemsFromCart", removed, removeMs);
  }
  ok("removeItemsFromCart", { itemCount: 0 }, removeMs);

  // Re-add for placeOrder
  const { data: reAdded, ms: reAddMs } = await mustGql<{ addToCart: CartContents }>(
    session,
    "addToCart(re)",
    `mutation AddToCart($input: AddToCartInput!) {
      addToCart(input: $input) { ${cartFields} }
    }`,
    { input: { productId: product.databaseId, quantity: 1 } },
  );
  if ((reAdded.addToCart?.cart?.contents?.itemCount ?? 0) < 1) {
    fail("addToCart(re)", reAdded, reAddMs);
  }
  ok("addToCart(re)", { itemCount: reAdded.addToCart?.cart?.contents?.itemCount }, reAddMs);

  // --- subscription product (second line with frequency) ---
  {
    const { data: settingsData, ms: settingsMs } = await mustGql<{
      mielandSubscriptionSettings: {
        discounts: Array<{ frequency: string; discountPercent: number } | null> | null;
      } | null;
    }>(
      session,
      "mielandSubscriptionSettings",
      `query SubSettings {
        mielandSubscriptionSettings {
          discounts { frequency discountPercent }
        }
      }`,
    );
    const discounts = (settingsData.mielandSubscriptionSettings?.discounts ?? []).filter(
      Boolean,
    );
    ok("mielandSubscriptionSettings", { discountCount: discounts.length }, settingsMs);
  }

  if (subProduct) {
    const extraData = JSON.stringify({
      subscription_frequency: subscriptionFrequency,
    });
    const { data: subAdded, ms: subAddMs } = await mustGql<{ addToCart: CartContents }>(
      session,
      "addToCart(subscription)",
      `mutation AddToCart($input: AddToCartInput!) {
        addToCart(input: $input) { ${cartFieldsWithExtra} }
      }`,
      {
        input: {
          productId: subProduct.databaseId,
          quantity: 1,
          extraData,
        },
      },
    );
    const subNodes = (subAdded.addToCart?.cart?.contents?.nodes ?? []).filter(Boolean);
    const subLine = subNodes.find((n) =>
      (n?.extraData ?? []).some(
        (e) =>
          e &&
          (e.key === "subscription_frequency" || e.key === "_subscription_frequency") &&
          e.value === subscriptionFrequency,
      ),
    );
    if (!subLine) {
      fail(
        "addToCart(subscription)",
        {
          message: "expected cart line with subscription_frequency",
          frequency: subscriptionFrequency,
          productId: subProduct.databaseId,
          nodes: subNodes,
        },
        subAddMs,
      );
    }
    ok(
      "addToCart(subscription)",
      {
        productId: subProduct.databaseId,
        frequency: subscriptionFrequency,
        itemCount: subAdded.addToCart?.cart?.contents?.itemCount,
        key: subLine?.key,
        subtotal: subLine?.subtotal ?? null,
      },
      subAddMs,
    );
  } else {
    ok("addToCart(subscription)", "skipped (no second product)");
  }

  // Billing/shipping for checkout
  const { ms: addressMs } = await mustGql(
    session,
    "updateCustomer(address)",
    `mutation UpdateCustomer($input: UpdateCustomerInput!) {
      updateCustomer(input: $input) {
        customer { databaseId billing { country postcode } }
      }
    }`,
    {
      input: {
        billing: {
          firstName: "Smoke",
          lastName: "Test",
          address1: "1 Test St",
          city: "Auckland",
          state: "AUK",
          postcode: "1010",
          country: "NZ",
          email: loginData.login?.customer?.email,
          phone: "0210000000",
          overwrite: true,
        },
        shipping: {
          firstName: "Smoke",
          lastName: "Test",
          address1: "1 Test St",
          city: "Auckland",
          state: "AUK",
          postcode: "1010",
          country: "NZ",
          overwrite: true,
        },
        shippingSameAsBilling: true,
      },
    },
  );
  ok("updateCustomer(address)", undefined, addressMs);

  if (skipCheckout) {
    ok("placeOrder", "skipped (SMOKE_SKIP_CHECKOUT=1)");
  } else {
    type CheckoutData = {
      checkout: {
        result: string | null;
        order: { databaseId: number; status: string; total: string } | null;
      } | null;
    };
    const { data: checkoutData, ms: checkoutMs } = await mustGql<CheckoutData>(
      session,
      "placeOrder",
      `mutation Checkout($input: CheckoutInput!) {
        checkout(input: $input) {
          result
          order { databaseId status total }
        }
      }`,
      {
        input: {
          paymentMethod: "stripe",
          customerNote: "commerce-api smoke test",
          shipToDifferentAddress: false,
        },
      },
    );
    const order = checkoutData.checkout?.order;
    if (!order?.databaseId) fail("placeOrder", checkoutData, checkoutMs);
    ok(
      "placeOrder",
      {
        orderId: order.databaseId,
        status: order.status,
        total: order.total,
        result: checkoutData.checkout?.result,
      },
      checkoutMs,
    );
  }

  // --- subscriptions list (WP creates rows after order; soft if none yet) ---
  if (subProduct && !skipCheckout) {
    const { data: subsData, ms: subsMs } = await mustGql<{
      mielandSubscriptions: Array<{
        id: number;
        productId: number;
        frequency: string;
        status: string;
      } | null> | null;
    }>(
      session,
      "mielandSubscriptions",
      `query Subs($status: String) {
        mielandSubscriptions(status: $status) {
          id
          productId
          frequency
          status
        }
      }`,
      { status: "active" },
    );
    const subs = (subsData.mielandSubscriptions ?? []).filter(Boolean);
    const match = subs.find(
      (s) =>
        s &&
        s.productId === subProduct.databaseId &&
        s.frequency === subscriptionFrequency,
    );
    if (match) {
      ok(
        "mielandSubscriptions",
        {
          id: match.id,
          productId: match.productId,
          frequency: match.frequency,
          status: match.status,
        },
        subsMs,
      );
    } else {
      ok(
        "mielandSubscriptions",
        {
          note: "no matching active sub yet (WP owns capture after placeOrder)",
          productId: subProduct.databaseId,
          frequency: subscriptionFrequency,
          listed: subs.length,
        },
        subsMs,
      );
    }
  } else {
    ok("mielandSubscriptions", "skipped");
  }

  // --- list orders ---
  type OrdersData = {
    customer: {
      databaseId: number;
      orders: { nodes: Array<{ databaseId: number; status: string; total: string } | null> | null };
    } | null;
  };
  const { data: ordersData, ms: ordersMs } = await mustGql<OrdersData>(
    session,
    "listOrders",
    `query CustomerOrders($id: ID!) {
      customer(id: $id) {
        databaseId
        orders {
          nodes { databaseId status total }
        }
      }
    }`,
    { id: customerGid },
  );
  const orderCount = ordersData.customer?.orders?.nodes?.filter(Boolean).length ?? 0;
  ok("listOrders", { count: orderCount }, ordersMs);

  // --- logout (client-side: drop JWT; API has no logout mutation) ---
  session.auth = null;
  {
    const { json: afterLogout, ms: logoutMs } = await gql(
      session,
      `query CustomerOrders($id: ID!) {
      customer(id: $id) { databaseId }
    }`,
      { id: customerGid },
    );
    const denied = (afterLogout.errors ?? []).some((e) =>
      /auth/i.test(e.message),
    );
    if (!denied) fail("logout", afterLogout, logoutMs);
    ok("logout", "auth cleared; customer requires Authentication", logoutMs);
  }

  // APQ handshake still useful
  {
    const started = performance.now();
    const fakeHash = "a".repeat(64);
    const apq = await fetch(
      `${endpoint}?extensions=${encodeURIComponent(
        JSON.stringify({ persistedQuery: { version: 1, sha256Hash: fakeHash } }),
      )}`,
    );
    const apqJson = (await apq.json()) as GqlJson;
    const ms = performance.now() - started;
    const code = apqJson.errors?.[0]?.extensions?.code;
    if (code === "PERSISTED_QUERY_NOT_SUPPORTED") {
      fail("APQ", "must not return PersistedQueryNotSupported", ms);
    }
    ok("APQ", code ?? apqJson.errors?.[0]?.message, ms);
  }

  recordTiming("wall", performance.now() - smokeStarted, true);
  printTimingSummary();
  console.log("smoke done");
}

main().catch((err) => {
  printTimingSummary();
  if (process.exitCode) return;
  console.error(err);
  process.exit(1);
});
