# mieland-commerce

adgadgag



Node GraphQL commerce API for the Mieland headless shop (WooGraphQL-compatible subset).

## Package

See `[services/commerce-api](services/commerce-api)` for the Express + GraphQL Yoga service.

ACF flexible content: commerce GraphQL omits disabled layouts (ACF 6.5 `_layout_meta` indices and optional per-layout `disable` checkbox). See `services/commerce-api/README.md`.

WordPress helpers for REST checkout (Stripe save-payment, password-reset delegation) live in the `mieland-wordpress` mu-plugins tree as `mieland-rest-checkout-bridge.php`.