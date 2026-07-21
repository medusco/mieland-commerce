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

## Smoke

With the API running (`npm run dev`), set `SMOKE_USERNAME` / `SMOKE_PASSWORD` (and `consumerKey` / `consumerSecret` for placeOrder) then:

```powershell
npm run smoke
```

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
