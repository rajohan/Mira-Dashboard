import { getCacheEntry, parseJsonField } from "./cacheStore.js";

/** Represents moltbook announcement. */
export interface MoltbookAnnouncement {
    postId: string | null;
    title: string | null;
    authorName: string | null;
    createdAt: string | null;
    preview: string | null;
}

/** Represents moltbook home cache. */
export interface MoltbookHomeCache {
    pendingRequestCount: number;
    unreadMessageCount: number;
    activityOnYourPostsCount: number;
    activityOnYourPosts: unknown[];
    latestAnnouncement: MoltbookAnnouncement | null;
    postsFromAccountsYouFollowCount: number | null;
    exploreCount: number | null;
    nextActions: string[];
    fetchedAt: string;
}

/** Represents moltbook profile cache. */
export interface MoltbookProfileCache {
    agent: Record<string, unknown> | null;
}

/** Represents moltbook my content cache. */
export interface MoltbookMyContentCache {
    posts: unknown[];
    comments: unknown[];
}

/** Represents moltbook feed cache. */
export interface MoltbookFeedCache {
    posts: unknown[];
    feedType: string | null;
    feedFilter: string | null;
    hasMore: boolean;
    tip: string | null;
}

/** Represents the moltbook cache API response. */
export interface MoltbookCacheResponse<T> {
    source: string;
    status: string;
    updatedAt: string | null;
    expiresAt: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    consecutiveFailures: number;
    data: T;
    meta: Record<string, unknown>;
}

/** Fetches cached moltbook entry. */
async function fetchCachedMoltbookEntry<T>(
    key: string
): Promise<MoltbookCacheResponse<T>> {
    const row = await getCacheEntry(key);
    if (!row || row.status !== "fresh") {
        throw new Error(`Moltbook cache entry not found or not fresh: ${key}`);
    }

    const data = parseJsonField<T>(row.data);
    if (!data) {
        throw new Error(`Moltbook cache payload is invalid: ${key}`);
    }

    return {
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || null,
        expiresAt: row.expires_at || null,
        errorCode: row.error_code || null,
        errorMessage: row.error_message || null,
        consecutiveFailures: Number(row.consecutive_failures || 0),
        data,
        meta: parseJsonField<Record<string, unknown>>(row.meta) ?? {},
    };
}

/** Fetches cached moltbook home. */
export async function fetchCachedMoltbookHome() {
    return fetchCachedMoltbookEntry<MoltbookHomeCache>("moltbook.home");
}

/** Fetches cached moltbook profile. */
export async function fetchCachedMoltbookProfile() {
    return fetchCachedMoltbookEntry<MoltbookProfileCache>("moltbook.profile");
}

/** Fetches cached moltbook my content. */
export async function fetchCachedMoltbookMyContent() {
    return fetchCachedMoltbookEntry<MoltbookMyContentCache>("moltbook.my-content");
}

/** Fetches cached moltbook feed. */
export async function fetchCachedMoltbookFeed(sort: "hot" | "new") {
    return fetchCachedMoltbookEntry<MoltbookFeedCache>(`moltbook.feed.${sort}`);
}
