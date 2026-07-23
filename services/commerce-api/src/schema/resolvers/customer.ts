import type { AppContext } from "../../context.js";
import { requireUser } from "../../context.js";
import {
  createUser,
  findUserById,
  issueTokens,
  listEnabledLoginClients,
  loadProvider,
  refreshAuthToken,
  toGraphqlUser,
} from "../../auth/index.js";
import { saveWpAuthCookie } from "../../auth/wp-session.js";
import { wpGraphqlLogin } from "../../clients/wordpress-graphql.js";
import {
  getCustomer,
  requestWpPasswordReset,
  updateCustomerProfile,
} from "../../repositories/customers.js";
import { listCustomerOrders, getOrderById } from "../../repositories/orders.js";
import { bindCartToCustomer, loadCart, mutateCart } from "../../engine/cart-store.js";
import { parseDatabaseId } from "../../utils/index.js";
import { orderListNeedsFromInfo } from "../../utils/selection.js";
import type { CartAddress } from "../../engine/types.js";
import type { GraphQLResolveInfo } from "graphql";

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "yes";
}

function mapAddress(input?: CartAddress & { overwrite?: boolean } | null): CartAddress {
  if (!input) return {};
  return {
    firstName: input.firstName,
    lastName: input.lastName,
    company: input.company,
    address1: input.address1,
    address2: input.address2,
    city: input.city,
    state: input.state,
    postcode: input.postcode,
    country: input.country,
    phone: input.phone,
    email: input.email,
  };
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
    ) => {
      const userId = requireUser(ctx);
      const id = parseDatabaseId(args.id);
      return getOrderById(id, userId);
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
      // Guest-safe shipping/billing updates for rate calc (no id / session cart)
      if (input.id) {
        const userId = requireUser(ctx);
        const requested = parseDatabaseId(input.id);
        if (requested !== userId) throw new Error("Not authorized");
        await updateCustomerProfile(userId, {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          password: input.password,
          billing: input.billing,
          shipping: input.shipping,
          shippingSameAsBilling: input.shippingSameAsBilling,
        });
        // Mirror addresses onto cart session
        await mutateCart(ctx.sessionToken, async (cart) => {
          if (input.billing) {
            cart.billing = { ...cart.billing, ...mapAddress(input.billing) };
          }
          if (input.shipping) {
            cart.shipping = { ...cart.shipping, ...mapAddress(input.shipping) };
          }
          cart.customerId = userId;
          return { cart, result: undefined };
        });
        return {
          clientMutationId: input.clientMutationId,
          customer: await getCustomer(userId, ctx.sessionToken),
        };
      }

      // Session-only address update (guest)
      await mutateCart(ctx.sessionToken, async (cart) => {
        if (input.billing) {
          cart.billing = { ...cart.billing, ...mapAddress(input.billing) };
        }
        if (input.shipping) {
          cart.shipping = { ...cart.shipping, ...mapAddress(input.shipping) };
        }
        if (input.shippingSameAsBilling === false) {
          cart.shippingSameAsBilling = false;
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
        user: result.user,
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
      // Vault the cookie server-side; mint commerce JWTs for Bearer auth so
      // verifyAccessToken works even when WP signs with GRAPHQL_LOGIN_JWT_SECRET_KEY
      // (or another secret that differs from commerce JWT_SECRET / MySQL settings).
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
      await saveWpAuthCookie(userId, wp.cookieHeader, wp.cookieTtlSeconds);

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
      };
    },

    refreshToken: async (
      _: unknown,
      { input }: { input: { refreshToken: string; clientMutationId?: string } },
    ) => {
      // Commerce-issued refresh tokens (login mints these after WP auth).
      // WP auth cookie in Redis is left untouched.
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
      return {
        clientMutationId: input.clientMutationId,
        success: true,
        ...refreshed,
      };
    },
  },
};
