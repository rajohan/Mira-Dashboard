import { getCacheEntry, parseJsonField } from "./cacheStore.ts";

/** Represents moltbook announcement. */
export interface MoltbookAnnouncement {
    postId: string | undefined;
    title: string | undefined;
    authorName: string | undefined;
    createdAt: string | undefined;
    previewText: string | undefined;
}

/** Represents moltbook home cache. */
export interface MoltbookHomeCache {
    pendingRequestCount: number;
    unreadMessageCount: number;
    activityOnYourPostsCount: number;
    activityOnYourPosts: unknown[];
    latestAnnouncement: MoltbookAnnouncement | undefined;
    postsFromAccountsYouFollowCount: number | undefined;
    exploreCount: number | undefined;
    nextActions: string[];
    fetchedAt: string;
}

/** Represents moltbook profile cache. */
export interface MoltbookProfileCache {
    agent: Record<string, unknown> | undefined;
}

/** Represents moltbook my content cache. */
export interface MoltbookMyContentCache {
    posts: unknown[];
    comments: unknown[];
}

/** Represents moltbook feed cache. */
export interface MoltbookFeedCache {
    posts: unknown[];
    feedType: string | undefined;
    feedFilter: string | undefined;
    hasMore: boolean;
    tip: string | undefined;
}

/** Represents the moltbook cache API response. */
export interface MoltbookCacheResponse<T> {
    source: string;
    status: string;
    updatedAt: string | undefined;
    lastAttemptAt: string | undefined;
    expiresAt: string | undefined;
    errorCode: string | undefined;
    errorMessage: string | undefined;
    consecutiveFailures: number;
    data: T;
    meta: Record<string, unknown>;
}

const CACHE_NULL_SENTINEL_FIELDS = new Set([
    "agent",
    "authorName",
    "createdAt",
    "exploreCount",
    "feedFilter",
    "feedType",
    "latestAnnouncement",
    "postId",
    "postsFromAccountsYouFollowCount",
    "previewText",
    "tip",
    "title",
]);

function normalizeCacheNulls(value: unknown): unknown {
    if (value === null) {
        return value;
    }
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [
                key,
                entry === null && CACHE_NULL_SENTINEL_FIELDS.has(key)
                    ? undefined
                    : normalizeCacheNulls(entry),
            ])
        );
    }
    return value;
}

/** Fetches cached moltbook entry. */
async function fetchCachedMoltbookEntry<T>(
    key: string
): Promise<MoltbookCacheResponse<T>> {
    const row = await getCacheEntry(key);
    if (!row || row.status !== "fresh") {
        throw new Error(`Moltbook cache entry not found or not fresh: ${key}`);
    }

    const parsedData = parseJsonField<T>(row.data);
    if (parsedData === undefined) {
        throw new Error(`Moltbook cache payload is invalid: ${key}`);
    }
    const data = normalizeCacheNulls(parsedData) as T;

    return {
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at || undefined,
        lastAttemptAt: row.last_attempt_at || undefined,
        expiresAt: row.expires_at || undefined,
        errorCode: row.error_code || undefined,
        errorMessage: row.error_message || undefined,
        consecutiveFailures: Number(row.consecutive_failures),
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
