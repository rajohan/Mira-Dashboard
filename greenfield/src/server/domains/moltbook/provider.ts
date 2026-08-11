import { Redacted } from "effect";
import * as v from "valibot";

import { cacheEntryPayloadSchema } from "../../../contracts/cache.ts";
import {
    type MoltbookDashboardCachePayload,
    moltbookDashboardCachePayloadSchema,
    moltbookFeedMaximumPosts,
    moltbookNextActionsMaximum,
    moltbookOwnCommentsMaximum,
    moltbookOwnPostsMaximum,
} from "../../../contracts/moltbook.ts";

const moltbookApiOrigin = "https://www.moltbook.com";
const moltbookApiBasePath = "/api/v1";
const moltbookResponseMaximumBytes = 256 * 1024;
export const moltbookRequestTimeoutMs = 20_000;

export class MoltbookProviderFailure extends Error {
    readonly reason: "invalid-response" | "timeout" | "unavailable";

    constructor(reason: MoltbookProviderFailure["reason"]) {
        super("Moltbook provider failed");
        this.name = "MoltbookProviderFailure";
        this.reason = reason;
    }
}

export interface MoltbookDashboardCollector {
    readonly collect: (signal: AbortSignal) => Promise<MoltbookDashboardCachePayload>;
}

interface MoltbookFetchBodyReader {
    readonly cancel: (reason?: unknown) => Promise<void>;
    readonly read: () => Promise<{
        readonly done: boolean;
        readonly value?: Uint8Array;
    }>;
    readonly releaseLock: () => void;
}

interface MoltbookFetchBody {
    readonly cancel: (reason?: unknown) => Promise<void>;
    readonly getReader: () => MoltbookFetchBodyReader;
}

export interface MoltbookFetchResponse {
    readonly body: MoltbookFetchBody | null;
    readonly headers: { readonly get: (name: string) => string | null };
    readonly ok: boolean;
}

export type MoltbookFetch = (
    url: URL,
    init: RequestInit
) => Promise<MoltbookFetchResponse>;

export interface MoltbookDashboardCollectorOptions {
    readonly agentName: string;
    readonly apiKey: Redacted.Redacted<string>;
    readonly fetch?: MoltbookFetch;
    readonly nowMs?: () => number;
    readonly timeoutMs?: number;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new MoltbookProviderFailure("invalid-response");
    }
    return value as Readonly<Record<string, unknown>>;
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
    return value === undefined || value === null ? undefined : record(value);
}

function array(value: unknown): readonly unknown[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new MoltbookProviderFailure("invalid-response");
    return value;
}

function optionalString(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
        throw new MoltbookProviderFailure("invalid-response");
    }
    return value;
}

function requiredString(value: unknown): string {
    const output = optionalString(value);
    if (output === undefined) throw new MoltbookProviderFailure("invalid-response");
    return output;
}

function nonnegativeCount(value: unknown): number {
    if (value === undefined || value === null) return 0;
    const numeric =
        typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
            ? Number(value)
            : value;
    if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 0) {
        throw new MoltbookProviderFailure("invalid-response");
    }
    return numeric;
}

function signedInteger(value: unknown): number {
    const numeric =
        typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/u.test(value)
            ? Number(value)
            : value;
    if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
        throw new MoltbookProviderFailure("invalid-response");
    }
    return numeric;
}

function timestampMilliseconds(value: unknown): number {
    const parsed = Date.parse(requiredString(value));
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new MoltbookProviderFailure("invalid-response");
    }
    return parsed;
}

function optionalTimestampMilliseconds(value: unknown): number | undefined {
    return value === undefined || value === null
        ? undefined
        : timestampMilliseconds(value);
}

function booleanValue(value: unknown, fallback = false): boolean {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "boolean") {
        throw new MoltbookProviderFailure("invalid-response");
    }
    return value;
}

async function cancelResponse(
    response: MoltbookFetchResponse,
    reason: string
): Promise<void> {
    try {
        await response.body?.cancel(reason);
    } catch {
        // Rejected provider bodies are discarded without exposing diagnostics.
    }
}

async function boundedJsonResponse(
    response: MoltbookFetchResponse,
    signal: AbortSignal
): Promise<unknown> {
    if (!response.ok) {
        await cancelResponse(response, "Moltbook provider returned an error status");
        throw new MoltbookProviderFailure("unavailable");
    }
    const contentType =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ??
        "";
    if (contentType !== "application/json") {
        await cancelResponse(response, "Moltbook provider response was not JSON");
        throw new MoltbookProviderFailure("invalid-response");
    }
    const declared = response.headers.get("content-length")?.trim();
    if (
        declared !== undefined &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(declared) ||
            Number(declared) > moltbookResponseMaximumBytes)
    ) {
        await cancelResponse(response, "Moltbook provider response exceeded its budget");
        throw new MoltbookProviderFailure("invalid-response");
    }
    if (response.body === null) throw new MoltbookProviderFailure("invalid-response");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const result = await reader.read();
            if (result.done) break;
            const chunk = result.value as Uint8Array;
            totalBytes += chunk.byteLength;
            if (totalBytes > moltbookResponseMaximumBytes) {
                await reader
                    .cancel("Moltbook provider response exceeded its budget")
                    .catch(() => {});
                throw new MoltbookProviderFailure("invalid-response");
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    if (totalBytes < 2) {
        throw new MoltbookProviderFailure("invalid-response");
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new MoltbookProviderFailure("invalid-response");
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new MoltbookProviderFailure("invalid-response");
    }
}

function normalizeFeedPost(value: unknown) {
    const post = record(value);
    const author = optionalRecord(post.author);
    const authorName = optionalString(author?.name) ?? optionalString(post.author_name);
    if (authorName === undefined) throw new MoltbookProviderFailure("invalid-response");
    const id = optionalString(post.post_id) ?? optionalString(post.id);
    if (id === undefined) throw new MoltbookProviderFailure("invalid-response");
    const submolt = optionalRecord(post.submolt);
    return {
        author: {
            ...(optionalString(author?.display_name) === undefined
                ? {}
                : { displayName: optionalString(author?.display_name) }),
            name: authorName,
        },
        commentCount: nonnegativeCount(post.comment_count),
        contentPreview:
            optionalString(post.content_preview) ?? optionalString(post.content) ?? "",
        createdAtMs: timestampMilliseconds(post.created_at),
        downvotes: nonnegativeCount(post.downvotes),
        id,
        submoltName: optionalString(post.submolt_name) ?? requiredString(submolt?.name),
        title: requiredString(post.title),
        upvotes: nonnegativeCount(post.upvotes),
        ...(post.you_follow_author === undefined
            ? {}
            : { youFollowAuthor: booleanValue(post.you_follow_author) }),
    };
}

function normalizeFeed(value: unknown, sort: "hot" | "new") {
    const feed = record(value);
    return {
        ...(optionalString(feed.feed_filter) === undefined
            ? {}
            : { filter: optionalString(feed.feed_filter) }),
        hasMore: booleanValue(feed.has_more),
        posts: array(feed.posts)
            .slice(0, moltbookFeedMaximumPosts)
            .map((post) => normalizeFeedPost(post)),
        sort,
        ...(optionalString(feed.tip) === undefined
            ? {}
            : { tip: optionalString(feed.tip) }),
    };
}

function normalizeOwnPost(value: unknown) {
    const post = record(value);
    const submolt = record(post.submolt);
    return {
        commentCount: nonnegativeCount(post.comment_count),
        contentPreview:
            optionalString(post.content_preview) ?? optionalString(post.content) ?? "",
        createdAtMs: timestampMilliseconds(post.created_at),
        downvotes: nonnegativeCount(post.downvotes),
        id: requiredString(post.id),
        submoltName: requiredString(submolt.name),
        title: requiredString(post.title),
        upvotes: nonnegativeCount(post.upvotes),
    };
}

function normalizeOwnComment(value: unknown) {
    const comment = record(value);
    const post = record(comment.post);
    const submolt = record(post.submolt);
    return {
        content: requiredString(comment.content),
        createdAtMs: timestampMilliseconds(comment.created_at),
        downvotes: nonnegativeCount(comment.downvotes),
        id: requiredString(comment.id),
        post: {
            id: requiredString(post.id),
            submoltName: requiredString(submolt.name),
            title: requiredString(post.title),
        },
        upvotes: nonnegativeCount(comment.upvotes),
    };
}

function nextAction(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const action = optionalRecord(value);
    return (
        optionalString(action?.label) ??
        optionalString(action?.title) ??
        optionalString(action?.action)
    );
}

function normalizeHome(value: unknown) {
    const home = record(value);
    const messages = optionalRecord(home.your_direct_messages);
    const account = optionalRecord(home.your_account);
    const announcement = optionalRecord(home.latest_moltbook_announcement);
    const normalizedAnnouncement =
        announcement === undefined
            ? undefined
            : {
                  ...(optionalString(announcement.author_name) === undefined
                      ? {}
                      : { authorName: optionalString(announcement.author_name) }),
                  ...(optionalTimestampMilliseconds(announcement.created_at) === undefined
                      ? {}
                      : {
                            createdAtMs: optionalTimestampMilliseconds(
                                announcement.created_at
                            ),
                        }),
                  ...(optionalString(announcement.post_id) === undefined
                      ? {}
                      : { postId: optionalString(announcement.post_id) }),
                  ...(optionalString(announcement.preview) === undefined
                      ? {}
                      : { previewText: optionalString(announcement.preview) }),
                  ...(optionalString(announcement.title) === undefined
                      ? {}
                      : { title: optionalString(announcement.title) }),
              };
    return {
        activityOnYourPostsCount: array(home.activity_on_your_posts).length,
        exploreCount: array(home.explore).length,
        ...(normalizedAnnouncement === undefined ||
        Object.keys(normalizedAnnouncement).length === 0
            ? {}
            : { latestAnnouncement: normalizedAnnouncement }),
        nextActions: array(home.what_to_do_next)
            .map((action) => nextAction(action))
            .filter((action): action is string => action !== undefined)
            .slice(0, moltbookNextActionsMaximum),
        pendingRequestCount: nonnegativeCount(messages?.pending_request_count),
        postsFromAccountsYouFollowCount: array(home.posts_from_accounts_you_follow)
            .length,
        unreadMessageCount: nonnegativeCount(messages?.unread_message_count),
        unreadNotificationCount: nonnegativeCount(account?.unread_notification_count),
    };
}

function normalizeProfile(value: unknown) {
    const response = record(value);
    const profile = optionalRecord(response.agent);
    if (profile === undefined) return;
    const name = requiredString(profile.name);
    return {
        commentsCount: nonnegativeCount(profile.comments_count),
        description: optionalString(profile.description) ?? "",
        displayName: optionalString(profile.display_name) ?? name,
        followerCount: nonnegativeCount(profile.follower_count),
        followingCount: nonnegativeCount(profile.following_count),
        karma: signedInteger(profile.karma),
        name,
        postsCount: nonnegativeCount(profile.posts_count),
    };
}

function normalizeOwnContent(value: unknown) {
    const response = record(value);
    return {
        comments: array(response.recentComments)
            .slice(0, moltbookOwnCommentsMaximum)
            .map((comment) => normalizeOwnComment(comment)),
        posts: array(response.recentPosts)
            .slice(0, moltbookOwnPostsMaximum)
            .map((post) => normalizeOwnPost(post)),
    };
}

function normalizeFailure(
    error: unknown,
    requestSignal: AbortSignal,
    timeoutSignal: AbortSignal
): never {
    if (requestSignal.aborted) throw error;
    if (timeoutSignal.aborted) throw new MoltbookProviderFailure("timeout");
    if (error instanceof MoltbookProviderFailure) throw error;
    throw new MoltbookProviderFailure("unavailable");
}

/**
 * Creates the fixed-host, read-only Moltbook collector used only by the worker.
 * @param options Redacted credential, configured agent identity, and injectable boundaries.
 * @returns One all-or-nothing bounded Dashboard snapshot collector.
 */
export function createMoltbookDashboardCollector(
    options: MoltbookDashboardCollectorOptions
): MoltbookDashboardCollector {
    const fetchImplementation: MoltbookFetch =
        options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const nowMs = options.nowMs ?? Date.now;
    const timeoutMs = options.timeoutMs ?? moltbookRequestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
        throw new RangeError("Moltbook request timeout is invalid");
    }
    const profileUrl = new URL(
        `${moltbookApiBasePath}/agents/profile`,
        moltbookApiOrigin
    );
    profileUrl.searchParams.set("name", options.agentName);
    const requestUrls = Object.freeze({
        home: new URL(`${moltbookApiBasePath}/home`, moltbookApiOrigin),
        hot: new URL(`${moltbookApiBasePath}/feed?sort=hot&limit=25`, moltbookApiOrigin),
        new: new URL(`${moltbookApiBasePath}/feed?sort=new&limit=25`, moltbookApiOrigin),
        profile: profileUrl,
    });

    return Object.freeze({
        async collect(requestSignal: AbortSignal) {
            requestSignal.throwIfAborted();
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const collectionController = new AbortController();
            const signal = AbortSignal.any([
                requestSignal,
                timeoutSignal,
                collectionController.signal,
            ]);
            const fetchJson = async (url: URL): Promise<unknown> => {
                const response = await fetchImplementation(url, {
                    headers: {
                        accept: "application/json",
                        authorization: `Bearer ${Redacted.value(options.apiKey)}`,
                    },
                    method: "GET",
                    redirect: "error",
                    signal,
                });
                return boundedJsonResponse(response, signal);
            };
            try {
                const [home, hot, newest, profile] = await Promise.all([
                    fetchJson(requestUrls.home),
                    fetchJson(requestUrls.hot),
                    fetchJson(requestUrls.new),
                    fetchJson(requestUrls.profile),
                ]);
                signal.throwIfAborted();
                const normalizedProfile = normalizeProfile(profile);
                const snapshot = v.parse(moltbookDashboardCachePayloadSchema, {
                    feeds: {
                        hot: normalizeFeed(hot, "hot"),
                        new: normalizeFeed(newest, "new"),
                    },
                    fetchedAtMs: nowMs(),
                    home: normalizeHome(home),
                    myContent: normalizeOwnContent(profile),
                    ...(normalizedProfile === undefined
                        ? {}
                        : { profile: normalizedProfile }),
                });
                v.parse(cacheEntryPayloadSchema, snapshot);
                return snapshot;
            } catch (error) {
                return normalizeFailure(error, requestSignal, timeoutSignal);
            } finally {
                collectionController.abort();
            }
        },
    });
}
