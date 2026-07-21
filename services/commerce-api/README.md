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

Covers login → addToCart → updateQuantity → removeFromCart → placeOrder → list orders → logout.

## Endpoints

| Path | Purpose |
|------|---------|
| `POST/GET /graphql` | GraphQL (session + JWT + APQ) |
| `GET /health` | Liveness |
| `GET /ready` | MySQL + Redis readiness |

## Session / auth

- `woocommerce-session: Session <token>` — Redis cart key; echoed on every response
- `Authorization: Bearer <JWT>` — signed with `wpgraphql_login_settings.jwt_secret_key` from MySQL (or `JWT_SECRET` override)
- Optional `x-graphql-secret` when `GRAPHQL_SECRET` is set

## Checkout

`checkout` / `createOrder` create orders via WC REST (`/wc/v3/orders`). Node does **not** insert `hy_mieland_subscriptions` rows — WordPress owns new-order subscription capture. Line meta `_subscription_frequency` is attached so WP can capture after place.

`updateMielandSubscription` / `cancelMielandSubscription` write existing subscription rows in MySQL (customer-scoped).

## WP bridge

See `mieland-rest-checkout-bridge.php` in the WordPress mu-plugins tree for Stripe save-payment forcing and password-reset / tax helpers.
