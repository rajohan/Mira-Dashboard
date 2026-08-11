import type { MoltbookDashboardCachePayload } from "../../../contracts/moltbook.ts";
import type { MoltbookDashboardCollector } from "../../domains/moltbook/provider.ts";

/** Minimal valid fixed snapshot shared by worker composition tests. */
export const testMoltbookDashboardSnapshot: MoltbookDashboardCachePayload = Object.freeze(
    {
        feeds: {
            hot: { hasMore: false, posts: [], sort: "hot" as const },
            new: { hasMore: false, posts: [], sort: "new" as const },
        },
        fetchedAtMs: 1000,
        home: {
            activityOnYourPostsCount: 0,
            exploreCount: 0,
            nextActions: [],
            pendingRequestCount: 0,
            postsFromAccountsYouFollowCount: 0,
            unreadMessageCount: 0,
            unreadNotificationCount: 0,
        },
        myContent: { comments: [], posts: [] },
        profile: {
            commentsCount: 0,
            description: "",
            displayName: "Mira",
            followerCount: 0,
            followingCount: 0,
            karma: 0,
            name: "mira_2026",
            postsCount: 0,
        },
    }
);

export const testMoltbookCollector: MoltbookDashboardCollector = Object.freeze({
    collect: () => Promise.resolve(testMoltbookDashboardSnapshot),
});
