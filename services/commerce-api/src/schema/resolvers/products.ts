import type { GraphQLResolveInfo } from "graphql";
import type { AppContext } from "../../context.js";
import {
  EMPTY_REVIEW_PAGE_INFO,
  paginateProductReviewEdges,
} from "../../repositories/reviews.js";
import { resolveProductFaq } from "../../repositories/product-faq.js";
import {
  productListNeedsFromInfo,
  productReviewsWantsEdges,
} from "../../utils/selection.js";

function linkedProductsResolver(metaKey: "_upsell_ids" | "_crosssell_ids") {
  return async (
    parent: { databaseId?: number | null },
    args: { first?: number },
  ) => {
    const productId = parent.databaseId;
    if (!productId) return { nodes: [] };

    const { getLinkedProductNodes } = await import("../../repositories/products.js");
    const nodes = await getLinkedProductNodes(productId, metaKey, args.first);
    return { nodes };
  };
}

const faqResolver = (
  parent: {
    databaseId?: number | null;
    parentDatabaseId?: number | null;
    __typename?: string | null;
    faq?: Array<{ title: string; content: string }> | null;
    _acfMeta?: Record<string, string>;
    _postMetaComplete?: boolean;
    parentFaqMeta?: Record<string, string> | null;
  },
) => resolveProductFaq(parent);

async function reviewsResolver(
  parent: {
    databaseId?: number | null;
    averageRating?: number | null;
    reviews?: {
      averageRating?: number | null;
      edges?: unknown[];
      pageInfo?: typeof EMPTY_REVIEW_PAGE_INFO;
    } | null;
  },
  args: { first?: number | null; after?: string | null },
  ctx: AppContext,
  info: GraphQLResolveInfo,
) {
  const averageRating = Number(
    parent.reviews?.averageRating ?? parent.averageRating ?? 0,
  );

  if (!productReviewsWantsEdges(info)) {
    return {
      averageRating,
      edges: [],
      pageInfo: EMPTY_REVIEW_PAGE_INFO,
    };
  }

  const productId = parent.databaseId;
  if (!productId) {
    return {
      averageRating,
      edges: [],
      pageInfo: EMPTY_REVIEW_PAGE_INFO,
    };
  }

  const all = await ctx.productReviewsLoader.load(productId);
  const page = paginateProductReviewEdges(all, args);
  return {
    averageRating,
    edges: page.edges,
    pageInfo: page.pageInfo,
  };
}

export const productResolvers = {
  Query: {
    products: async (
      _: unknown,
      args: { first?: number; where?: { include?: number[]; status?: string } },
      _ctx: unknown,
      info: GraphQLResolveInfo,
    ) => {
      const { listProducts } = await import("../../repositories/products.js");
      const nodes = await listProducts({
        first: args.first,
        include: args.where?.include,
        status: args.where?.status,
        needs: productListNeedsFromInfo(info),
      });
      return { nodes };
    },
  },
  Product: {
    __resolveType(obj: { __typename?: string }) {
      return obj.__typename === "VariableProduct"
        ? "VariableProduct"
        : "SimpleProduct";
    },
    title: (p: { name?: string; title?: string }) => p.title ?? p.name ?? "",
    faq: faqResolver,
    reviews: reviewsResolver,
  },
  SimpleProduct: {
    price: (p: { price?: string }) => p.price ?? null,
    regularPrice: (p: { regularPrice?: string }) => p.regularPrice ?? null,
    salePrice: (p: { salePrice?: string | null }) => p.salePrice ?? null,
    title: (p: { name?: string }) => p.name ?? "",
    faq: faqResolver,
    reviews: reviewsResolver,
    upsell: linkedProductsResolver("_upsell_ids"),
    crossSell: linkedProductsResolver("_crosssell_ids"),
  },
  VariableProduct: {
    price: (p: { price?: string }) => p.price ?? null,
    regularPrice: (p: { regularPrice?: string }) => p.regularPrice ?? null,
    salePrice: (p: { salePrice?: string | null }) => p.salePrice ?? null,
    title: (p: { name?: string }) => p.name ?? "",
    faq: faqResolver,
    reviews: reviewsResolver,
    upsell: linkedProductsResolver("_upsell_ids"),
    crossSell: linkedProductsResolver("_crosssell_ids"),
    variations: (
      parent: {
        variations?: {
          nodes: Array<{
            databaseId?: number;
            menuOrder?: number;
          }>;
        };
      },
      args: {
        first?: number;
        where?: {
          orderby?: { field?: string; order?: string };
        };
      },
    ) => {
      const field = (args.where?.orderby?.field ?? "MENU_ORDER").toUpperCase();
      const order = args.where?.orderby?.order?.toUpperCase() === "DESC" ? -1 : 1;
      const nodes = [...(parent.variations?.nodes ?? [])];

      nodes.sort((a, b) => {
        let cmp = 0;
        switch (field) {
          case "ID":
            cmp = (a.databaseId ?? 0) - (b.databaseId ?? 0);
            break;
          case "MENU_ORDER":
          default:
            cmp = (a.menuOrder ?? 0) - (b.menuOrder ?? 0);
            if (cmp === 0) cmp = (a.databaseId ?? 0) - (b.databaseId ?? 0);
            break;
        }
        return cmp * order;
      });

      return { nodes: args.first ? nodes.slice(0, args.first) : nodes };
    },
  },
  ProductVariation: {
    price: (p: { price?: string }) => p.price ?? null,
    regularPrice: (p: { regularPrice?: string }) => p.regularPrice ?? null,
    salePrice: (p: { salePrice?: string | null }) => p.salePrice ?? null,
    attributes: (p: {
      attributes?: { nodes?: Array<{ name: string; label: string; value: string }> };
    }) => ({ nodes: p.attributes?.nodes ?? [] }),
  },
};
