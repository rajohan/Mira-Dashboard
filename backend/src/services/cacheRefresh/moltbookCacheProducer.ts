import { database } from "../../database.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import {
    asRecord,
    errorMessage,
    fetchJson,
    nowIso,
    toNumber,
} from "./cacheProducerSupport.ts";

const MOLTBOOK_API = "https://www.moltbook.com/api/v1";

export const MOLTBOOK_CACHE_KEY_LIST = [
    "moltbook.home",
    "moltbook.feed.hot",
    "moltbook.feed.new",
    "moltbook.profile",
    "moltbook.my-content",
] as const;

export type MoltbookCacheKey = (typeof MOLTBOOK_CACHE_KEY_LIST)[number];

export const MOLTBOOK_CACHE_KEYS = new Set<string>(MOLTBOOK_CACHE_KEY_LIST);

async function fetchMoltbookJson(path: string): Promise<unknown> {
    const apiKey = process.env.MOLTBOOK_API_KEY?.trim();
    if (!apiKey) {
        throw new Error("MOLTBOOK_API_KEY is not configured");
    }
    return fetchJson(`${MOLTBOOK_API}${path}`, {
        Authorization: `Bearer ${apiKey}`,
    });
}

function normalizeMoltbookHome(value: unknown) {
    const data = asRecord(value);
    const dm = asRecord(data.your_direct_messages);
    const activity = Array.isArray(data.activity_on_your_posts)
        ? data.activity_on_your_posts
        : [];
    const next = Array.isArray(data.what_to_do_next) ? data.what_to_do_next : [];
    const announcement = asRecord(data.latest_moltbook_announcement);
    return {
        pendingRequestCount: toNumber(dm.pending_request_count),
        unreadMessageCount: toNumber(dm.unread_message_count),
        activityOnYourPostsCount: activity.length,
        activityOnYourPosts: activity.slice(0, 10),
        latestAnnouncement:
            Object.keys(announcement).length > 0
                ? {
                      postId: announcement.post_id ?? undefined,
                      title: announcement.title ?? undefined,
                      authorName: announcement.author_name ?? undefined,
                      createdAt: announcement.created_at ?? undefined,
                      previewText:
                          announcement.preview ?? announcement.isPreview ?? undefined,
                  }
                : undefined,
        postsFromAccountsYouFollowCount: Array.isArray(
            data.posts_from_accounts_you_follow
        )
            ? data.posts_from_accounts_you_follow.length
            : undefined,
        exploreCount: Array.isArray(data.explore) ? data.explore.length : undefined,
        nextActions: next,
        fetchedAt: nowIso(),
    };
}

function normalizeMoltbookFeed(value: unknown, sort: "hot" | "new") {
    const data = asRecord(value);
    return {
        posts: Array.isArray(data.posts) ? data.posts : [],
        feedType: data.feed_type ?? sort,
        feedFilter: data.feed_filter ?? undefined,
        hasMore: Boolean(data.has_more),
        tip: data.tip ?? undefined,
    };
}

type MoltbookFetchTask =
    | { kind: "home"; promise: Promise<unknown> }
    | {
          kind: "feed";
          key: MoltbookCacheKey;
          sort: "hot" | "new";
          promise: Promise<unknown>;
      }
    | { kind: "profile"; promise: Promise<unknown> };

function createMoltbookRefreshError(
    message: string,
    options: { cause: unknown; failedKeys: MoltbookCacheKey[] }
): Error & { failedKeys: MoltbookCacheKey[] } {
    return Object.assign(new Error(message, { cause: options.cause }), {
        failedKeys: options.failedKeys,
    });
}

function failedKeysForMoltbookTask(
    task: MoltbookFetchTask,
    requestedKeys: readonly MoltbookCacheKey[]
): MoltbookCacheKey[] {
    if (task.kind === "home") {
        return ["moltbook.home"];
    }
    if (task.kind === "feed") {
        return [task.key];
    }
    return ["moltbook.profile", "moltbook.my-content"].filter((key) =>
        requestedKeys.includes(key as MoltbookCacheKey)
    ) as MoltbookCacheKey[];
}

export function getMoltbookFailureKeys(error: unknown): MoltbookCacheKey[] | undefined {
    const failedKeys = asRecord(error).failedKeys;
    return Array.isArray(failedKeys) ? (failedKeys as MoltbookCacheKey[]) : undefined;
}

export async function refreshMoltbookCache(targetKey?: MoltbookCacheKey) {
    const requestedKeys = targetKey ? [targetKey] : MOLTBOOK_CACHE_KEY_LIST;
    const writes: Array<{
        key: MoltbookCacheKey;
        data: unknown;
        metadata: Record<string, unknown>;
    }> = [];
    const tasks: MoltbookFetchTask[] = [];
    const failedKeys = new Set<MoltbookCacheKey>();

    if (requestedKeys.includes("moltbook.home")) {
        tasks.push({ kind: "home", promise: fetchMoltbookJson("/home") });
    }

    for (const sort of ["hot", "new"] as const) {
        const key = `moltbook.feed.${sort}` as MoltbookCacheKey;
        if (!requestedKeys.includes(key)) continue;
        tasks.push({
            kind: "feed",
            key,
            sort,
            promise: fetchMoltbookJson(`/feed?sort=${sort}&limit=25`),
        });
    }

    if (
        requestedKeys.includes("moltbook.profile") ||
        requestedKeys.includes("moltbook.my-content")
    ) {
        tasks.push({
            kind: "profile",
            promise: fetchMoltbookJson("/agents/profile?name=mira_2026"),
        });
    }

    const results = await Promise.all(
        tasks.map(async (task) => {
            try {
                return {
                    isSuccess: true as const,
                    task,
                    value: await task.promise,
                };
            } catch (error) {
                return { error, isSuccess: false as const, task };
            }
        })
    );
    let firstFailure: unknown;
    for (const result of results) {
        if (!result.isSuccess) {
            firstFailure ??= result.error;
            for (const failedKey of failedKeysForMoltbookTask(
                result.task,
                requestedKeys
            )) {
                failedKeys.add(failedKey);
            }
            continue;
        }
        const { task, value } = result;

        if (task.kind === "home") {
            writes.push({
                key: "moltbook.home",
                data: normalizeMoltbookHome(value),
                metadata: { workflow: "Cache Foundation - Moltbook", kind: "home" },
            });
            continue;
        }

        if (task.kind === "feed") {
            writes.push({
                key: task.key,
                data: normalizeMoltbookFeed(value, task.sort),
                metadata: {
                    workflow: "Cache Foundation - Moltbook",
                    kind: "feed",
                    sort: task.sort,
                },
            });
            continue;
        }

        const profile = asRecord(value);
        if (requestedKeys.includes("moltbook.profile")) {
            writes.push({
                key: "moltbook.profile",
                data: { agent: profile.agent ?? undefined },
                metadata: { workflow: "Cache Foundation - Moltbook", kind: "profile" },
            });
        }
        if (requestedKeys.includes("moltbook.my-content")) {
            writes.push({
                key: "moltbook.my-content",
                data: {
                    posts: Array.isArray(profile.recentPosts) ? profile.recentPosts : [],
                    comments: Array.isArray(profile.recentComments)
                        ? profile.recentComments
                        : [],
                },
                metadata: {
                    workflow: "Cache Foundation - Moltbook",
                    kind: "my-content",
                },
            });
        }
    }

    if (firstFailure !== undefined && writes.length === 0) {
        throw createMoltbookRefreshError(
            `Moltbook refresh failed: ${errorMessage(firstFailure)}`,
            {
                cause: firstFailure,
                failedKeys: [...failedKeys],
            }
        );
    }

    database.run("SAVEPOINT moltbook_cache_write");
    try {
        for (const item of writes) {
            writeCacheSuccess({
                key: item.key,
                data: item.data,
                source: "moltbook-api",
                ttl: 30,
                ttlUnit: "minutes",
                metadata: item.metadata,
            });
        }
        database.run("RELEASE SAVEPOINT moltbook_cache_write");
    } catch (error) {
        database.run("ROLLBACK TO SAVEPOINT moltbook_cache_write");
        database.run("RELEASE SAVEPOINT moltbook_cache_write");
        throw error;
    }
    if (firstFailure !== undefined) {
        throw createMoltbookRefreshError("Moltbook refresh had sub-request failures", {
            cause: firstFailure,
            failedKeys: [...failedKeys],
        });
    }
    return { refreshed: writes.map((item) => item.key) };
}
