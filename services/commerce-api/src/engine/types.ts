export type CartExtraData = { key: string; value: string };

export type CartItem = {
  key: string;
  productId: number;
  variationId: number | null;
  quantity: number;
  extraData: CartExtraData[];
};

export type CartAddress = {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  phone?: string;
  email?: string;
};

export type CartState = {
  items: CartItem[];
  coupons: string[];
  chosenShippingMethods: string[];
  customerId: number | null;
  billing: CartAddress;
  shipping: CartAddress;
  shippingSameAsBilling: boolean;
};

export function emptyCart(customerId: number | null = null): CartState {
  return {
    items: [],
    coupons: [],
    chosenShippingMethods: [],
    customerId,
    billing: {},
    shipping: {},
    shippingSameAsBilling: true,
  };
}

export function parseExtraDataString(
  extraData?: string | null,
): CartExtraData[] {
  if (!extraData) return [];
  try {
    const parsed = JSON.parse(extraData) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (x): x is CartExtraData =>
            !!x &&
            typeof x === "object" &&
            typeof (x as CartExtraData).key === "string",
        )
        .map((x) => ({ key: x.key, value: String(x.value ?? "") }));
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>).map(
        ([key, value]) => ({ key, value: String(value ?? "") }),
      );
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function getItemFrequency(item: CartItem): string {
  for (const key of ["subscription_frequency", "_subscription_frequency"]) {
    const found = item.extraData.find((e) => e.key === key);
    if (found?.value) return found.value;
  }
  return "";
}

export const FREQUENCIES = [
  "weekly",
  "fortnightly",
  "monthly",
  "every_2_months",
  "every_3_months",
] as const;

export type Frequency = (typeof FREQUENCIES)[number];

export function isValidFrequency(f: string): f is Frequency {
  return (FREQUENCIES as readonly string[]).includes(f);
}

export function nextPaymentFrom(fromMysql: string, frequency: string): string {
  const base = Date.parse(fromMysql.includes("T") ? fromMysql : `${fromMysql}Z`);
  const d = new Date(Number.isFinite(base) ? base : Date.now());
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "fortnightly":
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case "monthly":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    case "every_2_months":
      d.setUTCMonth(d.getUTCMonth() + 2);
      break;
    case "every_3_months":
      d.setUTCMonth(d.getUTCMonth() + 3);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return d.toISOString().slice(0, 19).replace("T", " ");
}
