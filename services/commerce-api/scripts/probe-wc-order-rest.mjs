import { loadConfig } from "../src/config.js";

const orderId = Number(process.argv[2] || 3438);
const cfg = loadConfig();
const base = cfg.WORDPRESS_URL.replace(/\/$/, "");
const key = cfg.WC_CONSUMER_KEY!;
const secret = cfg.WC_CONSUMER_SECRET!;
const url = new URL(`${base}/wp-json/wc/v3/orders/${orderId}`);
url.searchParams.set("consumer_key", key);
url.searchParams.set("consumer_secret", secret);

const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
const body = await res.json();
console.log(
  JSON.stringify(
    {
      status: res.status,
      id: body.id,
      status_order: body.status,
      coupon_lines: body.coupon_lines,
      discount_total: body.discount_total,
      total: body.total,
      billing: body.billing?.email,
      meta_data: (body.meta_data ?? []).filter((m) =>
        /coupon|discount|held|error/i.test(`${m.key} ${m.value}`),
      ),
    },
    null,
    2,
  ),
);
