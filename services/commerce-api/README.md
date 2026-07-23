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
- `Authorization: Bearer <JWT>` — WPGraphQL Headless Login JWT (login/refresh are proxied to `{WORDPRESS_URL}/graphql`)
- On login, commerce captures the WordPress auth `Set-Cookie` headers and stores them **server-side only** in Redis (`wpAuthCookie:{userId}`). The cookie is never returned to the shop.
- Logged-in `checkout` / `createOrder` / `processOrderPayment` attach that cookie on WC REST and Store API calls so WordPress sees the real user
- Optional `x-graphql-secret` when `GRAPHQL_SECRET` is set

**WP prerequisite:** Headless Login → enable “Set authentication cookie” on the password/Google providers so login responses include `wordpress_logged_in_*` cookies.

## Checkout

`checkout` / `createOrder` create orders via WC REST (`/wc/v3/orders`). Logged-in orders use the real `customer_id` plus the vaulted WP cookie. Guests still create as `customer_id: 0`. Node does **not** insert `hy_mieland_subscriptions` rows — WordPress owns new-order subscription capture. Line meta `_subscription_frequency` is attached so WP can capture after place.

`processOrderPayment` pays an existing unpaid order via WooCommerce Store API `POST /wc/store/v1/checkout/{orderId}` (runs the Stripe gateway), with the vaulted WP cookie when the payer is logged in. Pass Store API `paymentData` (e.g. `stripe_source`) or WPGraphQL-style `_stripe_source_id`.

`updateMielandSubscription` / `cancelMielandSubscription` write existing subscription rows in MySQL (customer-scoped).

## WP bridge

See `mieland-rest-checkout-bridge.php` in the WordPress mu-plugins tree for Stripe save-payment forcing and password-reset / tax helpers.
