export const contentsStore = {
  answersData: [] as any[],
  upvotesData: [] as any[],
  answersPage: 1,
  upvotesPage: 1,
  hasMoreAnswers: true,
  hasMoreUpvotes: true,
  activeTab: "answers" as "answers" | "upvotes",
  sortBy: "time" as "time" | "vote",
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
  total: null as number | null,
  q: "",
  scrollPosition: 0,
  detailCache: {} as Record<string, { data: any; scrollPosition: number }>
};

export const followingStore = {
  activeTab: "users" as "users" | "feed" | "risk",
  users: [] as any[],
  summary: null as any,
  userQ: "",
  userModeFilter: "" as "" | "full" | "backed",
  feed: [] as any[],
  riskFeed: [] as any[],
  scrollPosition: 0,
  userDetailCache: {} as Record<string, { data: any; scrollPosition: number }>
};

export const recommendStore = {
  channel: "mix" as "mix" | "risk" | "authors" | "classic",
  seed: Date.now(),
  items: [] as any[],
  stats: null as any,
  scrollPosition: 0,
  aiCache: {} as Record<string, any>,
  similarCache: {} as Record<string, any[]>
};
