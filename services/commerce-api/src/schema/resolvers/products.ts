import type { GraphQLResolveInfo } from "graphql";
import { productListNeedsFromInfo } from "../../utils/selection.js";

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
  },
  SimpleProduct: {
    price: (p: { price?: string }) => p.price ?? null,
    regularPrice: (p: { regularPrice?: string }) => p.regularPrice ?? null,
    salePrice: (p: { salePrice?: string | null }) => p.salePrice ?? null,
    title: (p: { name?: string }) => p.name ?? "",
  },
  VariableProduct: {
    price: (p: { price?: string }) => p.price ?? null,
    regularPrice: (p: { regularPrice?: string }) => p.regularPrice ?? null,
    salePrice: (p: { salePrice?: string | null }) => p.salePrice ?? null,
    title: (p: { name?: string }) => p.name ?? "",
    variations: (
      parent: { variations?: { nodes: unknown[] } },
      args: { first?: number },
    ) => {
      const nodes = parent.variations?.nodes ?? [];
      return { nodes: args.first ? nodes.slice(0, args.first) : nodes };
    },
  },
  ProductVariation: {
    price: (p: { price?: string }) => p.price ?? null,
    regularPrice: (p: { regularPrice?: string }) => p.regularPrice ?? null,
    salePrice: (p: { salePrice?: string | null }) => p.salePrice ?? null,
  },
};
