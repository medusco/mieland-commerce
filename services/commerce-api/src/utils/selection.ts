import {
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLResolveInfo,
  type SelectionNode,
  Kind,
} from "graphql";

function expandSelections(
  selections: readonly SelectionNode[],
  fragments: Record<string, FragmentDefinitionNode>,
): FieldNode[] {
  const fields: FieldNode[] = [];
  for (const sel of selections) {
    if (sel.kind === Kind.FIELD) {
      if (sel.name.value !== "__typename") fields.push(sel);
    } else if (sel.kind === Kind.INLINE_FRAGMENT && sel.selectionSet) {
      fields.push(...expandSelections(sel.selectionSet.selections, fragments));
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const frag = fragments[sel.name.value];
      if (frag?.selectionSet) {
        fields.push(...expandSelections(frag.selectionSet.selections, fragments));
      }
    }
  }
  return fields;
}

function selectionsAt(
  info: GraphQLResolveInfo,
  path: string[],
): FieldNode[] | null {
  let fields = expandSelections(
    info.fieldNodes.flatMap((n) => n.selectionSet?.selections ?? []),
    info.fragments,
  );
  for (const segment of path) {
    const match = fields.find((f) => f.name.value === segment);
    if (!match?.selectionSet) return null;
    fields = expandSelections(match.selectionSet.selections, info.fragments);
  }
  return fields;
}

function hasAny(fields: FieldNode[] | null, names: string[]): boolean {
  if (!fields) return false;
  const set = new Set(names);
  return fields.some((f) => set.has(f.name.value));
}

export type CartFieldNeeds = {
  products: boolean;
  variations: boolean;
  lineSubtotal: boolean;
  lineExtraData: boolean;
  cartTotals: boolean;
  shippingMethods: boolean;
  coupons: boolean;
};

/** Detect which cart fields the operation actually selects. */
export function cartNeedsFromInfo(
  info: GraphQLResolveInfo,
  /** `root` = resolving `cart`; `payload` = mutation returning `{ cart { ... } }` */
  kind: "root" | "payload",
): CartFieldNeeds {
  const cartFields =
    kind === "payload" ? selectionsAt(info, ["cart"]) : selectionsAt(info, []);
  const contentFields = cartFields
    ? expandSelections(
        cartFields.find((f) => f.name.value === "contents")?.selectionSet
          ?.selections ?? [],
        info.fragments,
      )
    : [];
  const nodeFields = contentFields.length
    ? expandSelections(
        contentFields.find((f) => f.name.value === "nodes")?.selectionSet
          ?.selections ?? [],
        info.fragments,
      )
    : [];

  return {
    products: nodeFields.some((f) => f.name.value === "product"),
    variations: nodeFields.some((f) => f.name.value === "variation"),
    lineSubtotal: nodeFields.some((f) => f.name.value === "subtotal"),
    lineExtraData: nodeFields.some((f) => f.name.value === "extraData"),
    cartTotals: hasAny(cartFields, [
      "total",
      "subtotal",
      "shippingTotal",
      "totalTax",
    ]),
    shippingMethods: hasAny(cartFields, [
      "availableShippingMethods",
      "chosenShippingMethods",
    ]),
    coupons: hasAny(cartFields, ["appliedCoupons"]),
  };
}

export function cartNeedsPricing(needs: CartFieldNeeds): boolean {
  return (
    needs.cartTotals ||
    needs.lineSubtotal ||
    needs.shippingMethods ||
    needs.coupons
  );
}

export type OrderListNeeds = {
  addresses: boolean;
  lineItems: boolean;
  lineProducts: boolean;
  shippingLines: boolean;
  taxLines: boolean;
  meta: boolean;
};

/** Field needs under `orders { nodes { ... } }` (Customer.orders resolver). */
export function orderListNeedsFromInfo(info: GraphQLResolveInfo): OrderListNeeds {
  const nodeFields = selectionsAt(info, ["nodes"]) ?? [];
  const lineItemFields = expandSelections(
    nodeFields.find((f) => f.name.value === "lineItems")?.selectionSet
      ?.selections ?? [],
    info.fragments,
  );
  const lineNodeFields = expandSelections(
    lineItemFields.find((f) => f.name.value === "nodes")?.selectionSet
      ?.selections ?? [],
    info.fragments,
  );

  return {
    addresses: hasAny(nodeFields, ["billing", "shipping"]),
    lineItems: nodeFields.some((f) => f.name.value === "lineItems"),
    lineProducts: lineNodeFields.some(
      (f) => f.name.value === "product" || f.name.value === "variation",
    ),
    shippingLines: nodeFields.some((f) => f.name.value === "shippingLines"),
    taxLines: nodeFields.some((f) => f.name.value === "taxLines"),
    meta: hasAny(nodeFields, [
      "amazonMcfTrackingCode",
      "amazonMcfTracking",
      "transactionId",
    ]),
  };
}

export type ProductListNeeds = {
  price: boolean;
  images: boolean;
  categories: boolean;
  attributes: boolean;
  variations: boolean;
  content: boolean;
  reviews: boolean;
  stock: boolean;
  featured: boolean;
};

/** Field needs under `products { nodes { ... } }`. */
export function productListNeedsFromInfo(
  info: GraphQLResolveInfo,
): ProductListNeeds {
  const nodeFields = selectionsAt(info, ["nodes"]) ?? [];
  const names = new Set(nodeFields.map((f) => f.name.value));
  return {
    price:
      names.has("price") ||
      names.has("regularPrice") ||
      names.has("salePrice") ||
      names.has("onSale"),
    images:
      names.has("image") ||
      names.has("thumbnailFields") ||
      names.has("galleryImages"),
    categories: names.has("productCategories"),
    attributes: names.has("attributes"),
    variations: names.has("variations"),
    content: names.has("description") || names.has("shortDescription"),
    reviews:
      names.has("reviews") ||
      names.has("averageRating") ||
      names.has("reviewCount"),
    stock: names.has("stockStatus"),
    featured: names.has("featured"),
  };
}

/** True when list can skip heavy hydrate (variations/images/categories/etc.). */
export function productListIsLean(needs: ProductListNeeds): boolean {
  return (
    !needs.images &&
    !needs.categories &&
    !needs.attributes &&
    !needs.variations &&
    !needs.content &&
    !needs.reviews
  );
}
