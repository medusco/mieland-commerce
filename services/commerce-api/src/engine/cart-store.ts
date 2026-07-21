import { randomToken } from "../utils/index.js";
import { getRedis, withRedisLock } from "../redis/client.js";
import { loadConfig } from "../config.js";
import {
  CartState,
  CartItem,
  emptyCart,
  parseExtraDataString,
} from "./types.js";

function cartKey(token: string): string {
  return `cart:${token}`;
}

export async function loadCart(token: string): Promise<CartState> {
  const raw = await getRedis().get(cartKey(token));
  if (!raw) return emptyCart();
  try {
    return { ...emptyCart(), ...JSON.parse(raw) } as CartState;
  } catch {
    return emptyCart();
  }
}

export async function saveCart(token: string, cart: CartState): Promise<void> {
  const cfg = loadConfig();
  await getRedis().set(cartKey(token), JSON.stringify(cart), "EX", cfg.CART_TTL_SECONDS);
}

export async function clearCart(token: string): Promise<void> {
  await getRedis().del(cartKey(token));
}

export async function mutateCart<T>(
  token: string,
  fn: (cart: CartState) => Promise<{ cart: CartState; result: T }>,
): Promise<T> {
  return withRedisLock(`lock:cart:${token}`, 5000, async () => {
    const cart = await loadCart(token);
    const { cart: next, result } = await fn(cart);
    await saveCart(token, next);
    return result;
  });
}

export function makeCartItemKey(
  productId: number,
  variationId: number | null,
  extraData: ReturnType<typeof parseExtraDataString>,
): string {
  const freq =
    extraData.find((e) => e.key === "subscription_frequency")?.value ??
    extraData.find((e) => e.key === "_subscription_frequency")?.value ??
    "";
  return `${productId}:${variationId ?? 0}:${freq}:${randomToken(6)}`;
}

export function findMergeableItem(
  cart: CartState,
  productId: number,
  variationId: number | null,
  extraData: ReturnType<typeof parseExtraDataString>,
): CartItem | undefined {
  const freq =
    extraData.find((e) => e.key === "subscription_frequency")?.value ??
    extraData.find((e) => e.key === "_subscription_frequency")?.value ??
    "";
  return cart.items.find((item) => {
    const itemFreq =
      item.extraData.find((e) => e.key === "subscription_frequency")?.value ??
      item.extraData.find((e) => e.key === "_subscription_frequency")?.value ??
      "";
    return (
      item.productId === productId &&
      (item.variationId ?? 0) === (variationId ?? 0) &&
      itemFreq === freq
    );
  });
}

export async function bindCartToCustomer(
  token: string,
  customerId: number,
): Promise<void> {
  await mutateCart(token, async (cart) => ({
    cart: { ...cart, customerId },
    result: undefined,
  }));
}
