/**
 * OpenAPI 3.0 description of the commerce-api HTTP surface.
 * Primary API is GraphQL at POST/GET /graphql; REST is health/ready only.
 */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Mieland Commerce API",
    version: "0.1.0",
    description: `
Lean Express + GraphQL Yoga service (WooGraphQL / WooCommerce–compatible subset) for the Mieland shop.

## Transport
- **GraphQL** — \`POST /graphql\` (and \`GET /graphql\` for APQ / simple queries)
- **Health** — \`GET /health\`, \`GET /ready\`

## Auth & session
| Header | Purpose |
|--------|---------|
| \`Authorization: Bearer <JWT>\` | Customer auth (from \`login\` / \`registerCustomer\`) |
| \`woocommerce-session: Session <token>\` | Cart session; echoed on every GraphQL response |
| \`x-graphql-secret\` | Optional shared secret when \`GRAPHQL_SECRET\` is set |
| \`x-request-id\` | Optional request correlation id |

## GraphQL operations

### Queries
\`cart\`, \`products\`, \`customer\`, \`order\`, \`loginClients\`, \`mielandSubscriptionSettings\`, \`mielandSubscriptions\`, \`mielandSubscription\`, \`posts\`, \`post\`, \`categories\`, \`pages\`, \`page\`, \`navigation\`, \`labResults\`

### Mutations
\`addToCart\`, \`removeItemsFromCart\`, \`updateItemQuantities\`, \`updateShippingMethod\`, \`applyCoupon\`, \`removeCoupons\`, \`createOrder\`, \`checkout\`, \`updateCustomer\`, \`registerCustomer\`, \`sendPasswordResetEmail\`, \`login\`, \`refreshToken\`, \`updateMielandSubscription\`, \`cancelMielandSubscription\`

Use the **Try it out** examples on \`POST /graphql\`, or open GraphiQL at \`/graphql\` in non-production.
`.trim(),
  },
  servers: [
    { url: "http://localhost:4000", description: "Local" },
    { url: "/", description: "Current host" },
  ],
  tags: [
    { name: "Health", description: "Liveness and readiness probes" },
    { name: "GraphQL", description: "Primary commerce API (Yoga)" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["Health"],
        summary: "Liveness",
        operationId: "getHealth",
        responses: {
          "200": {
            description: "Process is up",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/HealthOk" },
                example: { status: "ok" },
              },
            },
          },
        },
      },
    },
    "/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness (MySQL + Redis)",
        operationId: "getReady",
        responses: {
          "200": {
            description: "Dependencies reachable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReadyOk" },
                example: { status: "ready", mysql: true, redis: true },
              },
            },
          },
          "503": {
            description: "MySQL and/or Redis unavailable",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ReadyFail" },
                example: { status: "not_ready", mysql: false, redis: true },
              },
            },
          },
        },
      },
    },
    "/graphql": {
      post: {
        tags: ["GraphQL"],
        summary: "GraphQL HTTP endpoint",
        description:
          "Send a GraphQL document. Prefer picking an **example** below. Responses include `woocommerce-session: Session <token>` — send it back on later cart calls.",
        operationId: "postGraphql",
        parameters: [
          { $ref: "#/components/parameters/Authorization" },
          { $ref: "#/components/parameters/WooSession" },
          { $ref: "#/components/parameters/GraphqlSecret" },
          { $ref: "#/components/parameters/RequestId" },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/GraphQLRequest" },
              examples: {
                login: {
                  summary: "login (PASSWORD)",
                  value: {
                    query: `mutation Login($input: LoginInput!) {
  login(input: $input) {
    authToken
    refreshToken
    sessionToken
    customer { id databaseId email }
  }
}`,
                    variables: {
                      input: {
                        provider: "PASSWORD",
                        credentials: {
                          username: "customer@example.com",
                          password: "secret",
                        },
                      },
                    },
                  },
                },
                getProducts: {
                  summary: "products (lean list)",
                  value: {
                    query: `query GetProducts($first: Int = 10) {
  products(first: $first, where: { status: "publish" }) {
    nodes {
      databaseId
      name
      __typename
      ... on SimpleProduct { price }
      ... on VariableProduct { price }
    }
  }
}`,
                    variables: { first: 10 },
                  },
                },
                getCart: {
                  summary: "cart",
                  value: {
                    query: `query GetCart {
  cart {
    contents {
      itemCount
      nodes { key quantity }
    }
  }
}`,
                  },
                },
                addToCart: {
                  summary: "addToCart",
                  value: {
                    query: `mutation AddToCart($input: AddToCartInput!) {
  addToCart(input: $input) {
    cart {
      contents {
        itemCount
        nodes { key quantity }
      }
    }
  }
}`,
                    variables: {
                      input: { productId: 2560, quantity: 1 },
                    },
                  },
                },
                updateItemQuantities: {
                  summary: "updateItemQuantities",
                  value: {
                    query: `mutation UpdateQty($input: UpdateItemQuantitiesInput!) {
  updateItemQuantities(input: $input) {
    cart {
      contents {
        itemCount
        nodes { key quantity }
      }
    }
  }
}`,
                    variables: {
                      input: {
                        items: [{ key: "2560:0::abc123", quantity: 2 }],
                      },
                    },
                  },
                },
                removeItemsFromCart: {
                  summary: "removeItemsFromCart",
                  value: {
                    query: `mutation Remove($input: RemoveItemsFromCartInput!) {
  removeItemsFromCart(input: $input) {
    cart { contents { itemCount } }
  }
}`,
                    variables: {
                      input: { keys: ["2560:0::abc123"] },
                    },
                  },
                },
                checkout: {
                  summary: "checkout (place order)",
                  value: {
                    query: `mutation Checkout($input: CheckoutInput!) {
  checkout(input: $input) {
    result
    order { databaseId status total }
  }
}`,
                    variables: {
                      input: {
                        paymentMethod: "stripe",
                        customerNote: "api docs example",
                        shipToDifferentAddress: false,
                      },
                    },
                  },
                },
                customerOrders: {
                  summary: "customer.orders",
                  value: {
                    query: `query CustomerOrders($id: ID!) {
  customer(id: $id) {
    databaseId
    orders {
      nodes { databaseId status total }
    }
  }
}`,
                    variables: { id: "<customer-global-id>" },
                  },
                },
                refreshToken: {
                  summary: "refreshToken",
                  value: {
                    query: `mutation Refresh($input: RefreshTokenInput!) {
  refreshToken(input: $input) {
    success
    authToken
    authTokenExpiration
  }
}`,
                    variables: {
                      input: { refreshToken: "<refresh-token>" },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "GraphQL envelope (HTTP 200 even for many GraphQL errors)",
            headers: {
              "woocommerce-session": {
                description: "Session <token> for cart continuity",
                schema: { type: "string", example: "Session eyJ..." },
              },
            },
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GraphQLResponse" },
              },
            },
          },
          "429": { description: "Rate limited" },
          "500": { description: "Unhandled server error" },
        },
      },
      get: {
        tags: ["GraphQL"],
        summary: "GraphQL over GET (APQ / query string)",
        description:
          "Supports persisted queries via `extensions.persistedQuery` and optional `query` / `variables` query params.",
        operationId: "getGraphql",
        parameters: [
          { $ref: "#/components/parameters/Authorization" },
          { $ref: "#/components/parameters/WooSession" },
          {
            name: "query",
            in: "query",
            schema: { type: "string" },
            description: "GraphQL document (optional with APQ)",
          },
          {
            name: "variables",
            in: "query",
            schema: { type: "string" },
            description: "JSON-encoded variables",
          },
          {
            name: "extensions",
            in: "query",
            schema: { type: "string" },
            description:
              'JSON, e.g. `{"persistedQuery":{"version":1,"sha256Hash":"..."}}`',
          },
        ],
        responses: {
          "200": {
            description: "GraphQL envelope",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/GraphQLResponse" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    parameters: {
      Authorization: {
        name: "Authorization",
        in: "header",
        required: false,
        schema: { type: "string" },
        example: "Bearer eyJhbGciOiJIUzI1NiJ9...",
        description: "JWT from login / registerCustomer",
      },
      WooSession: {
        name: "woocommerce-session",
        in: "header",
        required: false,
        schema: { type: "string" },
        example: "Session <token>",
        description: "Cart session token from a prior response",
      },
      GraphqlSecret: {
        name: "x-graphql-secret",
        in: "header",
        required: false,
        schema: { type: "string" },
        description: "Required when server GRAPHQL_SECRET is set",
      },
      RequestId: {
        name: "x-request-id",
        in: "header",
        required: false,
        schema: { type: "string" },
      },
    },
    schemas: {
      HealthOk: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["ok"] },
        },
      },
      ReadyOk: {
        type: "object",
        required: ["status", "mysql", "redis"],
        properties: {
          status: { type: "string", enum: ["ready"] },
          mysql: { type: "boolean" },
          redis: { type: "boolean" },
        },
      },
      ReadyFail: {
        type: "object",
        required: ["status", "mysql", "redis"],
        properties: {
          status: { type: "string", enum: ["not_ready"] },
          mysql: { type: "boolean" },
          redis: { type: "boolean" },
        },
      },
      GraphQLRequest: {
        type: "object",
        properties: {
          query: { type: "string", description: "GraphQL document" },
          operationName: { type: "string", nullable: true },
          variables: {
            type: "object",
            additionalProperties: true,
            nullable: true,
          },
          extensions: {
            type: "object",
            additionalProperties: true,
            nullable: true,
            description: "e.g. persistedQuery for APQ",
          },
        },
      },
      GraphQLResponse: {
        type: "object",
        properties: {
          data: { type: "object", additionalProperties: true, nullable: true },
          errors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                message: { type: "string" },
                path: { type: "array", items: {} },
                extensions: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies Record<string, unknown>;
