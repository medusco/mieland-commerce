import type { AppContext } from "../../context.js";
import {
  getNavigation,
  getPageByUri,
  getPostBySlug,
  listCategories,
  listPages,
  listPosts,
  searchLabResults,
} from "../../repositories/content.js";

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
    post: async (
      _: unknown,
      args: { id: string; idType?: string },
    ) => {
      if (args.idType === "SLUG" || !args.idType) {
        return getPostBySlug(String(args.id));
      }
      return getPostBySlug(String(args.id));
    },
    categories: async (_: unknown, args: { first?: number }) =>
      listCategories(args.first ?? 50),
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
  HomepagePageBlock: {
    __resolveType(obj: { fieldGroupName?: string; __typename?: string }) {
      if (obj.__typename) return obj.__typename;
      const name = obj.fieldGroupName ?? "";
      if (name.includes("TrustBadge")) {
        return "HomepageFieldsPageBlocksTrustBadgeMarqueeLayout";
      }
      if (name.includes("TopSellers")) {
        return "HomepageFieldsPageBlocksTopSellersLayout";
      }
      if (name.includes("Benefits")) {
        return "HomepageFieldsPageBlocksBenefitsSpotlightLayout";
      }
      if (name.includes("HoneyGuide")) {
        return "HomepageFieldsPageBlocksHoneyGuideTilesLayout";
      }
      if (name.includes("Comparison")) {
        return "HomepageFieldsPageBlocksComparisonBlockLayout";
      }
      if (name.includes("Instagram")) {
        return "HomepageFieldsPageBlocksInstagramReelsLayout";
      }
      if (name.includes("ContentTabs")) {
        return "HomepageFieldsPageBlocksContentTabsLayout";
      }
      if (name.includes("Faq")) {
        return "HomepageFieldsPageBlocksFaqBlockLayout";
      }
      if (name.includes("Quiz")) {
        return "HomepageFieldsPageBlocksQuizPromoLayout";
      }
      return "HomepageFieldsPageBlocksTrustBadgeMarqueeLayout";
    },
  },
};

void (null as unknown as AppContext);
