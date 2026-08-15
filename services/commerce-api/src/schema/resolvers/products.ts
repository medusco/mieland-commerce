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
