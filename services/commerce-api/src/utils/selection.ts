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
  /** TaxCloud bridge — only when totalTax / taxSuccess / taxMessage selected. */
  tax: boolean;
  shippingMethods: boolean;
  coupons: boolean;
};

function fieldNamesUnder(
  parentFields: FieldNode[],
  fragments: Record<string, FragmentDefinitionNode>,
  childName: string,
): Set<string> {
  const child = parentFields.find((f) => f.name.value === childName);
  if (!child?.selectionSet) return new Set();
  const under = expandSelections(child.selectionSet.selections, fragments);
  return new Set(under.map((f) => f.name.value));
}

function productListNeedsFromNames(names: Set<string>): ProductListNeeds {
  return {
    price:
      names.has("price") ||
      names.has("regularPrice") ||
      names.has("salePrice") ||
      names.has("onSale"),
    acfThumbnail: names.has("thumbnailFields"),
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
    stock:
      names.has("stockStatus") ||
      names.has("stockQuantity") ||
      names.has("manageStock"),
    featured: names.has("featured"),
  };
}

function mergeProductListNeeds(
  a: ProductListNeeds,
  b: ProductListNeeds,
): ProductListNeeds {
  return {
    price: a.price || b.price,
    acfThumbnail: a.acfThumbnail || b.acfThumbnail,
    images: a.images || b.images,
    categories: a.categories || b.categories,
    attributes: a.attributes || b.attributes,
    variations: a.variations || b.variations,
    content: a.content || b.content,
    reviews: a.reviews || b.reviews,
    stock: a.stock || b.stock,
    featured: a.featured || b.featured,
  };
}

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
      "taxSuccess",
      "taxMessage",
    ]),
    tax: hasAny(cartFields, ["totalTax", "taxSuccess", "taxMessage"]),
    shippingMethods: hasAny(cartFields, [
      "availableShippingMethods",
      "chosenShippingMethods",
      "freeShippingInfo",
    ]),
    coupons: hasAny(cartFields, ["appliedCoupons"]),
  };
}

/**
 * Product hydrate needs from cart line `product { node { ... } }` and
 * `variation { node { ... } }` selections. Never loads parent `variations`.
 */
export function cartProductListNeedsFromInfo(
  info: GraphQLResolveInfo,
  kind: "root" | "payload",
): ProductListNeeds | null {
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

  const wantsProduct = nodeFields.some((f) => f.name.value === "product");
  const wantsVariation = nodeFields.some((f) => f.name.value === "variation");
  if (!wantsProduct && !wantsVariation) return null;

  let merged: ProductListNeeds = {
    price: false,
    acfThumbnail: false,
    images: false,
    categories: false,
    attributes: false,
    variations: false,
    content: false,
    reviews: false,
    stock: false,
    featured: false,
  };

  if (wantsProduct) {
    const productNames = fieldNamesUnder(nodeFields, info.fragments, "product");
    const productNodeNames = fieldNamesUnder(
      expandSelections(
        nodeFields.find((f) => f.name.value === "product")?.selectionSet
          ?.selections ?? [],
        info.fragments,
      ),
      info.fragments,
      "node",
    );
    merged = mergeProductListNeeds(
      merged,
      productListNeedsFromNames(new Set([...productNames, ...productNodeNames])),
    );
  }

  if (wantsVariation) {
    const variationNames = fieldNamesUnder(nodeFields, info.fragments, "variation");
    const variationNodeNames = fieldNamesUnder(
      expandSelections(
        nodeFields.find((f) => f.name.value === "variation")?.selectionSet
          ?.selections ?? [],
        info.fragments,
      ),
      info.fragments,
      "node",
    );
    merged = mergeProductListNeeds(
      merged,
      productListNeedsFromNames(
        new Set([...variationNames, ...variationNodeNames]),
      ),
    );
  }

  // Cart never hydrates all parent variations — only the line's variation node.
  merged.variations = false;

  return merged;
}

export function cartNeedsPricing(needs: CartFieldNeeds): boolean {
  return (
    needs.cartTotals ||
    needs.lineSubtotal ||
    needs.shippingMethods ||
    needs.coupons ||
    // Product/variation price fields in cart must include subscription discount.
    needs.products ||
    needs.variations
  );
}

export type OrderListNeeds = {
  addresses: boolean;
  lineItems: boolean;
  lineProducts: boolean;
  shippingLines: boolean;
  taxLines: boolean;
  couponLines: boolean;
  meta: boolean;
  /** Call WP mcf-tra bridge to refresh Amazon TRA when cache is empty (detail views). */
  refreshMcf: boolean;
};

/** Field needs under an Order selection (path e.g. `["order"]` or `["nodes"]`). */
export function orderNeedsFromInfo(
  info: GraphQLResolveInfo,
  path: string[],
): OrderListNeeds {
  const nodeFields = selectionsAt(info, path) ?? [];
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

  const wantsMcf = hasAny(nodeFields, [
    "amazonMcfTrackingCode",
    "amazonMcfTracking",
    "amazonMcfTraNumber",
    "amazonMcfTraUpdates",
  ]);

  return {
    addresses: hasAny(nodeFields, ["billing", "shipping"]),
    lineItems: nodeFields.some((f) => f.name.value === "lineItems"),
    lineProducts: lineNodeFields.some(
      (f) => f.name.value === "product" || f.name.value === "variation",
    ),
    shippingLines: nodeFields.some((f) => f.name.value === "shippingLines"),
    taxLines: nodeFields.some((f) => f.name.value === "taxLines"),
    couponLines: nodeFields.some((f) => f.name.value === "couponLines"),
    meta: wantsMcf || hasAny(nodeFields, ["transactionId"]),
    // Live Amazon refresh only for single-order selections (not list `nodes`).
    refreshMcf: wantsMcf && path[path.length - 1] !== "nodes",
  };
}

/** True when Order can be mapped from WC REST scalars (no MySQL hydrate). */
export function orderNeedsAreLean(needs: OrderListNeeds): boolean {
  return (
    !needs.addresses &&
    !needs.lineItems &&
    !needs.shippingLines &&
    !needs.taxLines &&
    !needs.couponLines &&
    !needs.meta
  );
}

/** Field needs under `orders { nodes { ... } }` (Customer.orders resolver). */
export function orderListNeedsFromInfo(info: GraphQLResolveInfo): OrderListNeeds {
  return orderNeedsFromInfo(info, ["nodes"]);
}

export type ProductListNeeds = {
  price: boolean;
  /** ACF card thumbnail — pre-hydrated into product Redis cache when true. */
  acfThumbnail: boolean;
  images: boolean;
  categories: boolean;
  attributes: boolean;
  variations: boolean;
  content: boolean;
  reviews: boolean;
  stock: boolean;
  featured: boolean;
};

/** Default product hydrate for cart line items (no all-variations load). */
export const CART_PRODUCT_LIST_NEEDS: ProductListNeeds = {
  price: true,
  acfThumbnail: true,
  images: true,
  categories: false,
  attributes: false,
  variations: false,
  content: false,
  reviews: true,
  stock: true,
  featured: false,
};

/** Full catalog hydrate (orders, productLoader default). */
export const FULL_PRODUCT_LIST_NEEDS: ProductListNeeds = {
  price: true,
  acfThumbnail: false,
  images: true,
  categories: true,
  attributes: true,
  variations: true,
  content: true,
  reviews: true,
  stock: true,
  featured: true,
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
    acfThumbnail: names.has("thumbnailFields"),
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
    stock: names.has("stockStatus") || names.has("stockQuantity") || names.has("manageStock"),
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

export type PostHydrateNeeds = {
  excerpt: boolean;
  content: boolean;
  author: boolean;
  categories: boolean;
  tags: boolean;
  featuredImage: boolean;
  honeyGuideFeatured: boolean;
  honeyGuideRecommended: boolean;
  shopContentBlocks: boolean;
};

export const FULL_POST_HYDRATE_NEEDS: PostHydrateNeeds = {
  excerpt: true,
  content: true,
  author: true,
  categories: true,
  tags: true,
  featuredImage: true,
  honeyGuideFeatured: true,
  honeyGuideRecommended: true,
  shopContentBlocks: true,
};

function postHydrateNeedsFromNames(
  names: Set<string>,
  honeyGuideNames: Set<string>,
  shopNames: Set<string>,
): PostHydrateNeeds {
  return {
    excerpt: names.has("excerpt"),
    content: names.has("content"),
    author: names.has("author"),
    categories: names.has("categories"),
    tags: names.has("tags"),
    featuredImage: names.has("featuredImage"),
    honeyGuideFeatured:
      honeyGuideNames.has("isFeatured") || names.has("honeyGuideFields"),
    honeyGuideRecommended: honeyGuideNames.has("recommendedProducts"),
    shopContentBlocks:
      shopNames.has("contentBlocks") || names.has("shopFields"),
  };
}

function postHydrateNeedsFromFields(
  info: GraphQLResolveInfo,
  path: string[],
): PostHydrateNeeds {
  const nodeFields = selectionsAt(info, path) ?? [];
  if (!nodeFields.length) return FULL_POST_HYDRATE_NEEDS;
  const names = new Set(nodeFields.map((field) => field.name.value));
  const honeyGuideNames = fieldNamesUnder(
    nodeFields,
    info.fragments,
    "honeyGuideFields",
  );
  const shopNames = fieldNamesUnder(nodeFields, info.fragments, "shopFields");
  return postHydrateNeedsFromNames(names, honeyGuideNames, shopNames);
}

/** Field needs under `posts { nodes { ... } }`. */
export function postListNeedsFromInfo(info: GraphQLResolveInfo): PostHydrateNeeds {
  return postHydrateNeedsFromFields(info, ["nodes"]);
}

/** Field needs under `post { ... }` (single article). */
export function postDetailNeedsFromInfo(info: GraphQLResolveInfo): PostHydrateNeeds {
  return postHydrateNeedsFromFields(info, []);
}
