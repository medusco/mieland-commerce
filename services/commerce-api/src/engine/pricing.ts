import { getOption } from "../repositories/options.js";
import { FREQUENCIES, getItemFrequency, isValidFrequency, type CartItem } from "./types.js";
import { roundMoney } from "../utils/index.js";

export async function getSubscriptionDiscounts(): Promise<
  Record<string, number>
> {
  const stored = await getOption<Record<string, number>>(
    "mieland_subscriptions_discounts",
  );
  const defaults: Record<string, number> = {};
  for (const f of FREQUENCIES) defaults[f] = 0;
  if (!stored || typeof stored !== "object") return defaults;
  for (const f of FREQUENCIES) {
    const v = Number(stored[f] ?? 0);
    defaults[f] = Math.min(100, Math.max(0, Math.round(v * 100) / 100));
  }
  return defaults;
}

export function applyFrequencyDiscount(
  unitPrice: number,
  frequency: string,
  discounts: Record<string, number>,
): number {
  if (!frequency || !isValidFrequency(frequency) || unitPrice <= 0) {
    return roundMoney(unitPrice);
  }
  const discount = discounts[frequency] ?? 0;
  if (discount <= 0) return roundMoney(unitPrice);
  return roundMoney(unitPrice * (1 - discount / 100));
}

export function lineUnitPrice(
  basePrice: number,
  item: CartItem,
  discounts: Record<string, number>,
): number {
  return applyFrequencyDiscount(basePrice, getItemFrequency(item), discounts);
}
