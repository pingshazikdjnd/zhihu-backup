export const contentsStore = {
  answersData: [] as any[],
  upvotesData: [] as any[],
  answersPage: 1,
  upvotesPage: 1,
  hasMoreAnswers: true,
  hasMoreUpvotes: true,
  activeTab: "answers" as "answers" | "upvotes",
  scrollPosition: 0
};

export const collectionsStore: Record<string, { data: any; scrollPosition: number; visibleCount: number }> = {};

export const allCollectionsStore = {
  activeTab: "collections" as "collections" | "items",
  collections: [] as any[],
  items: [] as any[],
  itemsPage: 1,
  hasMoreItems: true,
  scrollPosition: 0
};

export const questionsStore = {
  list: [] as any[],
  page: 1,
  hasMore: true
};
