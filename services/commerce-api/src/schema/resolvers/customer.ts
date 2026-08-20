import type { AppContext } from "../../context.js";
import {
  requireUser,
  scheduleWpRefreshSetCookie,
  setPendingWpAuthSetCookie,
} from "../../context.js";
import { resolveWpCookiePolicy } from "../../auth/cookie-policy.js";
import {
  createUser,
  findUserById,
  issueTokens,
  listEnabledLoginClients,
  loadProvider,
  refreshAuthToken,
  toGraphqlUser,
} from "../../auth/index.js";
import {
  buildWpAuthSetCookie,
  wpAuthHeaderValue,
  wpRefreshHeaderValue,
} from "../../auth/wp-session.js";
import { refreshWpSessionFromCookie } from "../../auth/wp-refresh.js";
import { wpGraphqlLogin } from "../../clients/wordpress-graphql.js";
import {
  getCustomer,
  requestWpPasswordReset,
  confirmWpPasswordReset,
  updateCustomerProfile,
} from "../../repositories/customers.js";
import { getOrCreatePersonalCoupon } from "../../repositories/coupons.js";
import { listCustomerOrders, getOrderById, getOrderMcfTraUpdates } from "../../repositories/orders.js";
import { bindCartToCustomer, loadCart, mutateCart } from "../../engine/cart-store.js";
import { parseDatabaseId } from "../../utils/index.js";
import {
  orderListNeedsFromInfo,
  orderNeedsFromInfo,
} from "../../utils/selection.js";
import type { CartAddress } from "../../engine/types.js";
import type { GraphQLResolveInfo } from "graphql";

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

function mapAddress(
  input?: CartAddress & { overwrite?: boolean } | null,
): CartAddress {
  if (!input) return {};
  const out: CartAddress = {};
  const keys = [
    "firstName",
    "lastName",
    "company",
    "address1",
    "address2",
    "city",
    "state",
    "postcode",
    "country",
    "phone",
    "email",
  ] as const;
  for (const key of keys) {
    if (input[key] !== undefined) out[key] = input[key];
  }
  return out;
}

/** Billing → shipping when shippingSameAsBilling (omit email). */
function shippingFromBilling(
  billing: CartAddress & { overwrite?: boolean },
): CartAddress & { overwrite?: boolean } {
  const { email: _email, ...rest } = billing;
  return rest;
}

export const customerResolvers = {
  Query: {
    customer: async (
      _: unknown,
      args: { id: string },
      ctx: AppContext,
    ) => {
      const userId = requireUser(ctx);
      const requested = parseDatabaseId(args.id);
      if (requested && requested !== userId) {
        throw new Error("Not authorized to view this customer");
      }
      const customer = await getCustomer(userId, ctx.sessionToken);
      if (!customer) return null;
      return customer;
    },
    order: async (
      _: unknown,
      args: { id: string; idType?: string },
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const userId = requireUser(ctx);
      const id = parseDatabaseId(args.id);
      return getOrderById(id, userId, orderNeedsFromInfo(info, []));
    },
    loginClients: async () => listEnabledLoginClients(),
  },
  Customer: {
    orders: async (
      parent: { databaseId: number },
      _: unknown,
      ctx: AppContext,
      info: GraphQLResolveInfo,
    ) => {
      const userId = requireUser(ctx);
      if (parent.databaseId !== userId) throw new Error("Not authorized");
      return listCustomerOrders(userId, orderListNeedsFromInfo(info));
    },
  },
  Order: {
    amazonMcfTraUpdates: async (
      parent: {
        databaseId?: number;
        amazonMcfTraNumber?: string | null;
      },
      args: { traNumber?: string | null; refresh?: boolean | null },
      ctx: AppContext,
    ) => {
      requireUser(ctx);
      const orderId = parent.databaseId;
      if (!orderId) return null;
      return getOrderMcfTraUpdates(orderId, {
        traNumber: args.traNumber || parent.amazonMcfTraNumber || null,
        refresh: args.refresh !== false,
      });
    },
  },
  Mutation: {
    updateCustomer: async (
      _: unknown,
      { input }: {
        input: {
          id?: string;
          firstName?: string;
          lastName?: string;
          email?: string;
          password?: string;
          billing?: CartAddress & { overwrite?: boolean };
          shipping?: CartAddress & { overwrite?: boolean };
          shippingSameAsBilling?: boolean;
          clientMutationId?: string;
        };
      },
      ctx: AppContext,
    ) => {
      // Persist when authenticated via JWT — storefront commerce mutations omit
      // `id` and expect the Bearer token to identify the customer. Without this,
      // delivery/billing updates only hit the cart session and never usermeta.
      const requestedId = input.id ? parseDatabaseId(input.id) : 0;
      if (input.password) {
        requireUser(ctx);
      }
      const userId =
        ctx.userId != null
          ? (() => {
              if (requestedId && requestedId !== ctx.userId) {
                throw new Error("Not authorized");
              }
              return ctx.userId;
            })()
          : null;

      const billing = input.billing;
      const shipping =
        input.shippingSameAsBilling && billing
          ? shippingFromBilling(billing)
          : input.shipping;

      if (userId != null) {
        await updateCustomerProfile(userId, {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          password: input.password,
          billing,
          shipping,
          shippingSameAsBilling: input.shippingSameAsBilling,
        });
        await mutateCart(ctx.sessionToken, async (cart) => {
          if (billing) {
            cart.billing = { ...cart.billing, ...mapAddress(billing) };
          }
          if (shipping) {
            cart.shipping = { ...cart.shipping, ...mapAddress(shipping) };
          }
          if (input.shippingSameAsBilling !== undefined) {
            cart.shippingSameAsBilling = Boolean(input.shippingSameAsBilling);
          }
          cart.customerId = userId;
          return { cart, result: undefined };
        });
        return {
          clientMutationId: input.clientMutationId,
          customer: await getCustomer(userId, ctx.sessionToken),
        };
      }

      // Guest / unauthenticated: session cart only (rate calc, checkout draft)
      if (input.id) {
        requireUser(ctx); // throws Authentication required
      }

      await mutateCart(ctx.sessionToken, async (cart) => {
        if (billing) {
          cart.billing = { ...cart.billing, ...mapAddress(billing) };
        }
        if (shipping) {
          cart.shipping = { ...cart.shipping, ...mapAddress(shipping) };
        }
        if (input.shippingSameAsBilling !== undefined) {
          cart.shippingSameAsBilling = Boolean(input.shippingSameAsBilling);
        }
        return { cart, result: undefined };
      });

      const cart = await loadCart(ctx.sessionToken);
      return {
        clientMutationId: input.clientMutationId,
        customer: {
          databaseId: cart.customerId,
          email: cart.billing.email ?? null,
          firstName: cart.billing.firstName ?? null,
          billing: cart.billing,
          shipping: cart.shipping,
        },
      };
    },

    registerCustomer: async (
      _: unknown,
      { input }: {
        input: {
          email: string;
          password: string;
          firstName?: string;
          lastName?: string;
          authenticate?: boolean;
          billing?: CartAddress;
          shipping?: CartAddress;
          clientMutationId?: string;
        };
      },
      ctx: AppContext,
    ) => {
      const user = await createUser({
        email: input.email,
        username: input.email,
        password: input.password,
        firstName: input.firstName,
        lastName: input.lastName,
      });
      if (input.billing || input.shipping) {
        await updateCustomerProfile(user.id, {
          billing: input.billing,
          shipping: input.shipping,
        });
      }
      await bindCartToCustomer(ctx.sessionToken, user.id);
      const tokens =
        input.authenticate !== false ? await issueTokens(user) : null;
      return {
        clientMutationId: input.clientMutationId,
        authToken: tokens?.authToken ?? null,
        refreshToken: tokens?.refreshToken ?? null,
        customer: await getCustomer(user.id, ctx.sessionToken),
      };
    },

    sendPasswordResetEmail: async (
      _: unknown,
      { input }: { input: { username: string; clientMutationId?: string } },
    ) => {
      const result = await requestWpPasswordReset(input.username);
      return {
        clientMutationId: input.clientMutationId,
        success: result.success,
        token: result.token,
        login: result.login,
        user: result.user,
      };
    },

    resetUserPassword: async (
      _: unknown,
      {
        input,
      }: {
        input: {
          key: string;
          password: string;
          login?: string | null;
          email?: string | null;
          id?: string | number | null;
          clientMutationId?: string;
        };
      },
    ) => {
      const login = input.login?.trim() || null;
      const email = input.email?.trim() || null;
      const id = input.id ?? null;
      if (!login && !email && (id === null || id === undefined || id === "")) {
        throw new Error("Provide login, email, or id with the reset key.");
      }
      const result = await confirmWpPasswordReset({
        key: input.key,
        password: input.password,
        login,
        email,
        id,
      });
      return {
        clientMutationId: input.clientMutationId,
        success: result.success,
        login: result.login,
      };
    },

    requestPersonalCoupon: async (
      _: unknown,
      { input }: { input: { email: string; couponId?: number | null; clientMutationId?: string } },
    ) => {
      const result = await getOrCreatePersonalCoupon(input.email, {
        templateCouponId: input.couponId ?? undefined,
      });
      return {
        clientMutationId: input.clientMutationId,
        created: result.created,
        coupon: {
          id: result.id,
          code: result.code,
          amount: result.amount,
          discountType: result.discountType,
          description: result.description,
          email: result.email,
        },
      };
    },

    login: async (
      _: unknown,
      { input }: {
        input: {
          provider: string;
          credentials?: { username: string; password: string };
          oauthResponse?: { code: string; state?: string };
          clientMutationId?: string;
        };
      },
      ctx: AppContext,
    ) => {
      const provider = String(input.provider).toLowerCase();
      const settings = await loadProvider(provider);
      if (provider !== "password" && provider !== "google") {
        throw new Error(`Provider ${provider} is not supported`);
      }
      if (settings && !truthy(settings.isEnabled)) {
        throw new Error(`Provider ${provider} is disabled`);
      }

      if (provider === "password" && !input.credentials) {
        throw new Error("credentials required");
      }
      if (provider === "google" && !input.oauthResponse?.code) {
        throw new Error("oauthResponse.code required");
      }

      // Proxy to WPGraphQL Headless Login so WP sets a real auth cookie.
      // Set HttpOnly `mc-wp-session` on the commerce domain (never Redis); mint commerce
      // JWTs for Bearer auth so verifyAccessToken works even when WP signs with
      // GRAPHQL_LOGIN_JWT_SECRET_KEY (or another secret that differs from
      // commerce JWT_SECRET / MySQL settings).
      const origin =
        ctx.req.headers.get("origin") ||
        ctx.req.headers.get("Origin") ||
        null;
      const wp = await wpGraphqlLogin({
        provider,
        credentials: input.credentials,
        oauthResponse: input.oauthResponse,
        origin,
      });

      const userId = wp.user.databaseId;
      if (!wp.cookieHeader) {
        throw new Error(
          "WordPress login did not return an auth cookie — enable “Set authentication cookie” on the Headless Login provider",
        );
      }
      // Sibling subdomains (www → shop): SameSite=Lax + Domain=.example.com.
      const policy = resolveWpCookiePolicy(ctx.req);
      const setCookie = buildWpAuthSetCookie(
        wp.cookieHeader,
        wp.cookieTtlSeconds,
        { policy },
      );
      const headerValue = wpAuthHeaderValue(wp.cookieHeader);
      ctx.pendingWpAuthSetCookie = setCookie;
      // Dedicated map — Express reads this after yoga.fetch (context mutation alone is unreliable).
      if (ctx.requestScopeId) {
        setPendingWpAuthSetCookie(ctx.requestScopeId, setCookie, headerValue);
        if (wp.refreshToken) {
          scheduleWpRefreshSetCookie(
            ctx.requestScopeId,
            ctx.req,
            wp.refreshToken,
            wp.refreshTokenExpiration,
          );
        }
      }

      const user =
        (await findUserById(userId)) ?? {
          id: userId,
          email: wp.user.email ?? "",
          username: wp.user.username ?? "",
          firstName: wp.user.firstName ?? "",
          lastName: wp.user.lastName ?? "",
          displayName:
            [wp.user.firstName, wp.user.lastName].filter(Boolean).join(" ") ||
            wp.user.username ||
            wp.user.email ||
            "",
        };

      const tokens = await issueTokens(user);
      await bindCartToCustomer(ctx.sessionToken, userId);

      const customer =
        (await getCustomer(userId, ctx.sessionToken)) ??
        (wp.customer
          ? {
              ...wp.customer,
              databaseId: wp.customer.databaseId ?? userId,
              sessionToken: ctx.sessionToken,
            }
          : null);

      return {
        clientMutationId: input.clientMutationId,
        ...tokens,
        sessionToken: ctx.sessionToken,
        customer,
        user: toGraphqlUser(user),
        wpSession: headerValue,
        wpRefresh: wp.refreshToken
          ? wpRefreshHeaderValue(wp.refreshToken)
          : null,
      };
    },

    syncWordPressSession: async (
      _: unknown,
      { input }: { input?: { clientMutationId?: string } },
      ctx: AppContext,
    ) => {
      requireUser(ctx);
      const origin =
        ctx.req.headers.get("origin") ||
        ctx.req.headers.get("Origin") ||
        null;
      const renewed = await refreshWpSessionFromCookie({
        requestScopeId: ctx.requestScopeId,
        req: ctx.req,
        origin,
        wpRefreshToken: ctx.wpRefreshToken,
      });
      if (!renewed) {
        return {
          clientMutationId: input?.clientMutationId ?? null,
          success: false,
          wpSession: null,
          wpRefresh: null,
        };
      }
      return {
        clientMutationId: input?.clientMutationId ?? null,
        success: true,
        wpSession: renewed.sessionHeaderValue,
        wpRefresh: renewed.refreshHeaderValue,
      };
    },

    refreshToken: async (
      _: unknown,
      { input }: { input: { refreshToken: string; clientMutationId?: string } },
      ctx: AppContext,
    ) => {
      // Commerce-issued refresh tokens (login mints these after WP auth).
      const refreshed = await refreshAuthToken(input.refreshToken);
      if (!refreshed) {
        return {
          clientMutationId: input.clientMutationId,
          success: false,
          authToken: null,
          authTokenExpiration: null,
          refreshToken: null,
          refreshTokenExpiration: null,
        };
      }
      const origin =
        ctx.req.headers.get("origin") ||
        ctx.req.headers.get("Origin") ||
        null;
      const renewed = await refreshWpSessionFromCookie({
        requestScopeId: ctx.requestScopeId,
        req: ctx.req,
        origin,
        wpRefreshToken: ctx.wpRefreshToken,
      });
      const { userId: _userId, ...tokens } = refreshed;
      return {
        clientMutationId: input.clientMutationId,
        success: true,
        ...tokens,
        wpSession: renewed?.sessionHeaderValue ?? null,
        wpRefresh: renewed?.refreshHeaderValue ?? null,
      };
    },
  },
};
