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
import { resolveContentTemplateType } from "../../repositories/acf-graphql.js";

export const contentResolvers = {
  Query: {
    posts: async (
      _: unknown,
      args: {
        first?: number;
        where?: { status?: string; categoryName?: string };
      },
    ) =>
      listPosts({
        first: args.first,
        categoryName: args.where?.categoryName,
        status: args.where?.status,
      }),
    post: async (_: unknown, args: { id: string; idType?: string }) =>
      getPostBySlug(String(args.id)),
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
      args: { first?: number; where?: { status?: string } },
    ) => listPages(args.first ?? 100),
    page: async (_: unknown, args: { id: string; idType?: string }) =>
      getPageByUri(String(args.id)),
    navigation: async () => getNavigation(),
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
