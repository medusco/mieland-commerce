import type { GraphQLResolveInfo } from "graphql";
import type { AppContext } from "../../context.js";
import {
  getNavigation,
  getPageByUri,
  getPostBySlug,
  listCategories,
  listPages,
  listPosts,
  listProductCategories,
  searchLabResults,
  shapePageTemplate,
  type PageRecord,
} from "../../repositories/content.js";
import { getMenuItemsByLocation } from "../../repositories/menus.js";
import { resolveContentTemplateType } from "../../repositories/acf-graphql.js";
import {
  postDetailNeedsFromInfo,
  postListNeedsFromInfo,
} from "../../utils/selection.js";

export const contentResolvers = {
  Query: {
    posts: async (
      _: unknown,
      args: {
        first?: number;
        where?: { status?: string; categoryName?: string };
      },
      _ctx: unknown,
      info: GraphQLResolveInfo,
    ) =>
      listPosts({
        first: args.first,
        categoryName: args.where?.categoryName,
        status: args.where?.status,
        needs: postListNeedsFromInfo(info),
      }),
    post: async (
      _: unknown,
      args: { id: string; idType?: string },
      _ctx: unknown,
      info: GraphQLResolveInfo,
    ) => getPostBySlug(String(args.id), postDetailNeedsFromInfo(info)),
    categories: async (
      _: unknown,
      args: {
        first?: number;
        where?: { orderby?: string; order?: string };
      },
    ) => listCategories(args.first ?? 50, args.where),
    productCategories: async (_: unknown, args: { first?: number }) =>
      listProductCategories(args.first ?? 100),
    pages: async (
      _: unknown,
      args: { first?: number; where?: { status?: string; templateName?: string } },
    ) => listPages(args.first ?? 100, args.where),
    page: async (_: unknown, args: { id: string; idType?: string }) =>
      getPageByUri(String(args.id)),
    navigation: async () => getNavigation(),
    menuItems: async (
      _: unknown,
      args: { first?: number; where?: { location?: string } },
    ) => {
      const nodes = args.where?.location
        ? await getMenuItemsByLocation(args.where.location)
        : [];
      return { nodes: args.first ? nodes.slice(0, args.first) : nodes };
    },
    labResults: async (
      _: unknown,
      args: { where?: { title?: string; status?: string } },
    ) => searchLabResults(args.where?.title ?? ""),
  },
  Page: {
    template: (page: PageRecord) => shapePageTemplate(page),
  },
  ContentTemplate: {
    __resolveType(obj: { __typename?: string }) {
      return resolveContentTemplateType(obj.__typename);
    },
  },
};

void (null as unknown as AppContext);
