# Commerce API (Node)

Lean Express + TypeScript + GraphQL Yoga service that exposes a WooGraphQL/WooCommerce-compatible subset for the Mieland shop.

## Quick start

```powershell
cd services/commerce-api
Copy-Item .env.example .env
npm install
npm run dev
```

Requires MySQL (Woo `hy_` tables) and Redis. Point `GRAPHQL_ENDPOINT` in the mieland shop at `http://localhost:4000/graphql`.

Set `MEDIA_BASE_URL` (or `S3_UPLOADS_BUCKET_URL`) to the same public uploads CDN WordPress uses — e.g. `https://img.mieland.com` — so product/media `sourceUrl` values match the media library instead of frozen `posts.guid` hosts.

## Deploy (Railway)

Railpack fails if it analyzes the monorepo root (no root `package.json`). Use Docker:

1. **Repo root** — root `railway.toml` + `Dockerfile` build `services/commerce-api`, or
2. **Root Directory** = `services/commerce-api` — uses that folder’s `Dockerfile` / `railway.toml`.

Redeploy after this config is on the branch Railway builds.

## Smoke

Set `SMOKE_USERNAME` / `SMOKE_PASSWORD` (server under test needs `consumerKey` / `consumerSecret` for placeOrder).

Local (API on :4000):

```powershell
npm run smoke
```

Remote:

```powershell
npm run smoke -- --url https://your-commerce-api.up.railway.app
# or
$env:SMOKE_BASE_URL="https://your-commerce-api.up.railway.app"
npm run smoke
# or full GraphQL path
$env:GRAPHQL_URL="https://your-commerce-api.up.railway.app/graphql"
npm run smoke
```

`SMOKE_BASE_URL` / `--url` may be the service origin; `/graphql` is appended if missing.

Covers stock levels → login → addToCart (incl. OOS reject) → updateQuantity → removeFromCart → placeOrder → list orders → logout.

## Endpoints

| Path | Purpose |
|------|---------|
| `GET /health` | Liveness |
| `GET /ready` | MySQL + Redis readiness |
| `GET /docs` | Swagger UI (OpenAPI) |
| `GET /openapi.json` | OpenAPI 3 document |
| `POST/GET /graphql` | GraphQL (session + JWT + APQ) |

## Session / auth

- `woocommerce-session: Session <token>` — Redis cart key; echoed on every response
- `Authorization: Bearer <JWT>` — commerce-issued JWT after a successful WPGraphQL login
- On login, commerce proxies to WPGraphQL, captures WordPress auth `Set-Cookie` headers, and sets an HttpOnly `mc-wp-session` cookie (never Redis; Max-Age floored at 14 days). Prod uses `SameSite=None; Secure; Partitioned` for cross-origin storefronts; local HTTP uses `SameSite=Lax`. It also mints its own access/refresh JWTs (`JWT_ACCESS_TTL_SECONDS` default 14d, `JWT_REFRESH_TTL_SECONDS` default 30d) so Bearer verification always matches `JWT_SECRET` / `wpgraphql_login_settings.jwt_secret_key`
- Browser sends `mc-wp-session` on later GraphQL calls (`credentials: include`). Prefer the storefront `/api/commerce` proxy so the cookie is first-party when commerce is on another host. Logged-in `checkout` / `createOrder` / `processOrderPayment` require it; commerce forwards it only to WP Store API on pay
- Optional `x-graphql-secret` when `GRAPHQL_SECRET` is set

**WP prerequisite:** Headless Login → enable “Set authentication cookie” on the password/Google providers so login responses include `wordpress_logged_in_*` cookies.

**Note:** If WP defines `GRAPHQL_LOGIN_JWT_SECRET_KEY`, that can differ from the MySQL `jwt_secret_key`. Commerce therefore issues its own JWTs after WP authenticates the user, instead of returning WP’s `authToken` directly.

## Checkout

`checkout` / `createOrder` create orders via WC REST (`/wc/v3/orders`) using consumer key/secret only (no WP user cookie — a customer cookie would demote the request and return “not allowed to create resources”). Logged-in orders still set the real `customer_id`. Guests use `customer_id: 0`. Node does **not** insert `hy_mieland_subscriptions` rows — WordPress owns new-order subscription capture. Line meta `_subscription_frequency` is attached so WP can capture after place.

`processOrderPayment` pays via Store API `POST /wc/store/v1/checkout/{orderId}` and attaches the browser `mc-wp-session` cookie for logged-in payers so ownership matches. Pass WPGraphQL-style `_stripe_source_id` (`pm_…`); commerce maps it to Store API `wc-stripe-payment-method` + `stripe_source` and injects `payment_method: stripe` into `payment_data` (required because Store API replaces `$_POST` with `payment_data` only).

`updateMielandSubscription` / `cancelMielandSubscription` write existing subscription rows in MySQL (customer-scoped).

## Personal coupon

`requestPersonalCoupon(input: { email })` get-or-creates a one-time WooCommerce coupon restricted to that email (`usage_limit: 1`, `individual_use: true`). Repeat requests for the same email return the same code while unused (looked up via `mieland_personal_coupon_email` postmeta). Errors if Woo `usage_count` shows a real redemption, or if an unpaid (pending/failed/on-hold) order still holds the code — commerce returns a clear “incomplete checkout” message instead of cancelling that order. `applyCoupon` / checkout use the same checks. Cart totals skip spent coupons (`usage_count` ≥ `usage_limit`). Configure amount/type/prefix with `PERSONAL_COUPON_AMOUNT`, `PERSONAL_COUPON_DISCOUNT_TYPE`, `PERSONAL_COUPON_CODE_PREFIX`. Requires WC REST credentials. Apply the returned code with `applyCoupon`.

## WP bridge

See `mieland-rest-checkout-bridge.php` and `mieland-mcf-tra-api.php` in the WordPress mu-plugins tree for Stripe save-payment forcing, cart tax/shipping helpers, password reset, and MCF TRA.

Password reset: commerce `sendPasswordResetEmail` calls `POST /wp-json/mieland/v1/password-reset`, which runs WordPress `retrieve_password()` (mints key + sends lost-password email). Commerce does not return a reset token or send mail. Apply reset: commerce `resetUserPassword` calls `POST /wp-json/mieland/v1/password-reset/confirm` with `key` + `login` (or `email` / `id`) + new `password`.

Logged-in password change (`updateCustomer` with `password`) requires a commerce JWT. Commerce then calls `POST /wp-json/mieland/v1/set-password` with `X-Mieland-Internal-Secret` (never from the browser) so WordPress runs `reset_password` / `wp_set_password`. The WP route is not a public user API: it rejects requests without the shared secret (fail closed except local loopback). Set the same value in commerce `MIELAND_INTERNAL_REST_SECRET` and WP `MIELAND_INTERNAL_REST_SECRET` (or option `mieland_internal_rest_secret`). Falls back to Woo REST `PUT /wc/v3/customers/{id}`, then a direct `user_pass` write if both WP HTTP paths fail.

MCF TRA: order fields `amazonMcfTraNumber` / `amazonMcfTracking.traNumber` read `_ns_fba_*` order meta. On single-order queries, when TRA (or carrier tracking) is missing but `_sent_to_fba` is set, commerce calls `GET /wp-json/mieland/v1/orders/{id}/mcf-tra` (Amazon GetFulfillmentOrder via the MCF plugin). Set `MIELAND_INTERNAL_REST_SECRET` to match WP. Order lists use cached meta only (`refresh=0` equivalent).

MCF TRA updates: selecting `amazonMcfTraUpdates` on an order calls `GET /wp-json/mieland/v1/orders/{id}/mcf-tra/{traNumber}/updates` (Amazon getPackageTrackingDetails). Optional args: `traNumber` (defaults to primary TRA), `refresh` (default true; `false` is cache-only).
