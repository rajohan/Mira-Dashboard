import * as v from "valibot";

import { finiteNumberSchema, parseContract } from "./runtime";

const trimmedNonEmptyStringSchema = v.pipe(v.string(), v.trim(), v.nonEmpty());

export const moltbookAnnouncementSchema = v.object({
    authorName: v.optional(v.string()),
    createdAt: v.optional(v.string()),
    postId: v.optional(v.string()),
    previewText: v.optional(v.string()),
    title: v.optional(v.string()),
});

export const moltbookHomeSchema = v.strictObject({
    activityOnYourPosts: v.array(v.unknown()),
    activityOnYourPostsCount: finiteNumberSchema,
    exploreCount: v.optional(finiteNumberSchema),
    fetchedAt: trimmedNonEmptyStringSchema,
    latestAnnouncement: v.optional(moltbookAnnouncementSchema),
    nextActions: v.array(v.string()),
    pendingRequestCount: finiteNumberSchema,
    postsFromAccountsYouFollowCount: v.optional(finiteNumberSchema),
    unreadMessageCount: finiteNumberSchema,
});

const moltbookAuthorSchema = v.object({
    avatar_url: v.optional(v.string()),
    display_name: v.optional(v.string()),
    name: trimmedNonEmptyStringSchema,
});

/** Provider-owned post fields retained in the Moltbook feed cache. */
export const moltbookFeedPostPayloadSchema = v.pipe(
    v.looseObject({
        author: v.optional(moltbookAuthorSchema),
        author_name: v.optional(v.string()),
        comment_count: v.optional(finiteNumberSchema),
        content: v.optional(v.string()),
        content_preview: v.optional(v.string()),
        created_at: trimmedNonEmptyStringSchema,
        downvotes: v.optional(finiteNumberSchema),
        id: v.optional(v.string()),
        post_id: v.optional(v.string()),
        submolt_name: trimmedNonEmptyStringSchema,
        title: v.string(),
        upvotes: v.optional(finiteNumberSchema),
        you_follow_author: v.optional(v.boolean()),
    }),
    v.check((post) => Boolean(post.id || post.post_id), "must include id or post_id"),
    v.check(
        (post) => Boolean(post.author || post.author_name),
        "must include author or author_name"
    )
);

export const moltbookFeedSchema = v.object({
    feedFilter: v.optional(v.string()),
    feedType: v.optional(v.string()),
    hasMore: v.boolean(),
    posts: v.array(moltbookFeedPostPayloadSchema),
    tip: v.optional(v.string()),
});

export const moltbookProfileSchema = v.object({
    avatar_url: v.optional(v.string()),
    comments_count: finiteNumberSchema,
    description: v.string(),
    display_name: v.string(),
    follower_count: finiteNumberSchema,
    following_count: finiteNumberSchema,
    karma: finiteNumberSchema,
    name: trimmedNonEmptyStringSchema,
    posts_count: finiteNumberSchema,
});

export const moltbookProfileCacheSchema = v.strictObject({
    agent: v.optional(moltbookProfileSchema),
});

const submoltSchema = v.object({
    name: trimmedNonEmptyStringSchema,
});

export const moltbookOwnPostSchema = v.object({
    comment_count: finiteNumberSchema,
    content_preview: v.string(),
    created_at: trimmedNonEmptyStringSchema,
    downvotes: finiteNumberSchema,
    id: trimmedNonEmptyStringSchema,
    submolt: submoltSchema,
    title: v.string(),
    upvotes: finiteNumberSchema,
});

export const moltbookCommentSchema = v.object({
    content: v.string(),
    created_at: trimmedNonEmptyStringSchema,
    downvotes: finiteNumberSchema,
    id: trimmedNonEmptyStringSchema,
    post: v.object({
        id: trimmedNonEmptyStringSchema,
        submolt: submoltSchema,
        title: v.string(),
    }),
    upvotes: finiteNumberSchema,
});

export const moltbookContentSchema = v.strictObject({
    comments: v.array(moltbookCommentSchema),
    posts: v.array(moltbookOwnPostSchema),
});

export type MoltbookAnnouncement = v.InferOutput<typeof moltbookAnnouncementSchema>;
export type MoltbookHome = v.InferOutput<typeof moltbookHomeSchema>;
export type MoltbookFeedPostPayload = v.InferOutput<typeof moltbookFeedPostPayloadSchema>;
export type MoltbookFeed = v.InferOutput<typeof moltbookFeedSchema>;
export type MoltbookProfile = v.InferOutput<typeof moltbookProfileSchema>;
export type MoltbookProfileCache = v.InferOutput<typeof moltbookProfileCacheSchema>;
export type MoltbookOwnPost = v.InferOutput<typeof moltbookOwnPostSchema>;
export type MoltbookComment = v.InferOutput<typeof moltbookCommentSchema>;
export type MoltbookContent = v.InferOutput<typeof moltbookContentSchema>;

export interface MoltbookPost {
    author: {
        avatar_url?: string;
        display_name?: string;
        name: string;
    };
    comment_count: number;
    content: string;
    content_preview?: string;
    created_at: string;
    downvotes: number;
    id: string;
    submolt_name: string;
    title: string;
    upvotes: number;
    you_follow_author?: boolean;
}

/**
 * Parses the Dashboard-normalized Moltbook home cache payload.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the Dashboard-normalized Moltbook home cache payload.
 */
export function parseMoltbookHome(value: unknown, path = "moltbookHome"): MoltbookHome {
    return parseContract(moltbookHomeSchema, value, path);
}

/**
 * Parses one provider-owned Moltbook feed cache.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one provider-owned Moltbook feed cache.
 */
export function parseMoltbookFeed(value: unknown, path = "moltbookFeed"): MoltbookFeed {
    return parseContract(moltbookFeedSchema, value, path);
}

/**
 * Converts the provider feed representation into the frontend display model.
 * @returns Converted the provider feed representation into the frontend display model.
 */
export function moltbookPostFromPayload(post: MoltbookFeedPostPayload): MoltbookPost {
    return {
        author: post.author ?? {
            name: post.author_name ?? "unknown",
        },
        comment_count: post.comment_count ?? 0,
        content: post.content ?? post.content_preview ?? "",
        created_at: post.created_at,
        downvotes: post.downvotes ?? 0,
        id: post.post_id ?? post.id ?? "",
        submolt_name: post.submolt_name,
        title: post.title,
        upvotes: post.upvotes ?? 0,
        ...(post.content_preview !== undefined && {
            content_preview: post.content_preview,
        }),
        ...(post.you_follow_author !== undefined && {
            you_follow_author: post.you_follow_author,
        }),
    };
}

/**
 * Parses the profile fields rendered by the Dashboard.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the profile fields rendered by the Dashboard.
 */
export function parseMoltbookProfile(
    value: unknown,
    path = "moltbookProfile"
): MoltbookProfile {
    return parseContract(moltbookProfileSchema, value, path);
}

export function parseMoltbookProfileCache(
    value: unknown,
    path = "moltbookProfileCache"
): MoltbookProfileCache {
    return parseContract(moltbookProfileCacheSchema, value, path);
}

/**
 * Parses posts and comments authored by the configured Moltbook agent.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed posts and comments authored by the configured Moltbook agent.
 */
export function parseMoltbookContent(
    value: unknown,
    path = "moltbookContent"
): MoltbookContent {
    return parseContract(moltbookContentSchema, value, path);
}
