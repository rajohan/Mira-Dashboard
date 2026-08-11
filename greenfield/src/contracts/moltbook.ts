import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    hasNoUnicodeControlOrFormat,
    noNulStringAction,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";
import type { ProcedureContract } from "./registry.ts";
import { emptyInputSchema } from "./system.ts";

export const moltbookFeedMaximumPosts = 25;
export const moltbookOwnPostsMaximum = 25;
export const moltbookOwnCommentsMaximum = 50;
export const moltbookNextActionsMaximum = 8;

function boundedTextSchema(maximumLength: number, message: string) {
    return v.pipe(
        v.string(message),
        v.maxLength(maximumLength, message),
        noNulStringAction(message)
    );
}

function boundedDisplayTextSchema(maximumLength: number, message: string) {
    return v.pipe(
        boundedTextSchema(maximumLength, message),
        v.check(hasNoUnicodeControlOrFormat, message)
    );
}

const moltbookIdentitySchema = boundedControlSafeTextSchema(
    128,
    "Moltbook identity is invalid"
);
const moltbookTitleSchema = boundedDisplayTextSchema(500, "Moltbook title is invalid");
const moltbookContentSchema = boundedTextSchema(8000, "Moltbook content is invalid");
const moltbookCountSchema = nonnegativeSafeIntegerSchema("Moltbook count is invalid");
const moltbookKarmaSchema = v.pipe(
    v.number("Moltbook karma is invalid"),
    v.safeInteger("Moltbook karma is invalid")
);
const moltbookTimestampSchema = timestampMillisecondsSchema(
    "Moltbook timestamp is invalid"
);

export const moltbookAuthorSchema = v.strictObject({
    displayName: v.optional(
        boundedDisplayTextSchema(200, "Moltbook author display name is invalid")
    ),
    name: moltbookIdentitySchema,
});

export const moltbookFeedPostSchema = v.strictObject({
    author: moltbookAuthorSchema,
    commentCount: moltbookCountSchema,
    contentPreview: moltbookContentSchema,
    createdAtMs: moltbookTimestampSchema,
    downvotes: moltbookCountSchema,
    id: moltbookIdentitySchema,
    submoltName: moltbookIdentitySchema,
    title: moltbookTitleSchema,
    upvotes: moltbookCountSchema,
    youFollowAuthor: v.optional(v.boolean("Moltbook follow state is invalid")),
});

export const moltbookFeedSchema = v.strictObject({
    filter: v.optional(boundedDisplayTextSchema(80, "Moltbook feed filter is invalid")),
    hasMore: v.boolean("Moltbook feed continuation state is invalid"),
    posts: v.pipe(
        v.array(moltbookFeedPostSchema, "Moltbook feed posts are invalid"),
        v.maxLength(moltbookFeedMaximumPosts, "Moltbook feed is outside its row budget")
    ),
    sort: v.picklist(["hot", "new"], "Moltbook feed sort is invalid"),
    tip: v.optional(boundedTextSchema(1000, "Moltbook feed tip is invalid")),
});

export const moltbookProfileSchema = v.strictObject({
    commentsCount: moltbookCountSchema,
    description: boundedTextSchema(4000, "Moltbook profile description is invalid"),
    displayName: boundedDisplayTextSchema(
        200,
        "Moltbook profile display name is invalid"
    ),
    followerCount: moltbookCountSchema,
    followingCount: moltbookCountSchema,
    karma: moltbookKarmaSchema,
    name: moltbookIdentitySchema,
    postsCount: moltbookCountSchema,
});

export const moltbookOwnPostSchema = v.strictObject({
    commentCount: moltbookCountSchema,
    contentPreview: moltbookContentSchema,
    createdAtMs: moltbookTimestampSchema,
    downvotes: moltbookCountSchema,
    id: moltbookIdentitySchema,
    submoltName: moltbookIdentitySchema,
    title: moltbookTitleSchema,
    upvotes: moltbookCountSchema,
});

export const moltbookOwnCommentSchema = v.strictObject({
    content: moltbookContentSchema,
    createdAtMs: moltbookTimestampSchema,
    downvotes: moltbookCountSchema,
    id: moltbookIdentitySchema,
    post: v.strictObject({
        id: moltbookIdentitySchema,
        submoltName: moltbookIdentitySchema,
        title: moltbookTitleSchema,
    }),
    upvotes: moltbookCountSchema,
});

export const moltbookOwnContentSchema = v.strictObject({
    comments: v.pipe(
        v.array(moltbookOwnCommentSchema, "Moltbook comments are invalid"),
        v.maxLength(
            moltbookOwnCommentsMaximum,
            "Moltbook comments are outside their row budget"
        )
    ),
    posts: v.pipe(
        v.array(moltbookOwnPostSchema, "Moltbook posts are invalid"),
        v.maxLength(
            moltbookOwnPostsMaximum,
            "Moltbook posts are outside their row budget"
        )
    ),
});

export const moltbookHomeSchema = v.strictObject({
    activityOnYourPostsCount: moltbookCountSchema,
    exploreCount: moltbookCountSchema,
    latestAnnouncement: v.optional(
        v.strictObject({
            authorName: v.optional(
                boundedDisplayTextSchema(200, "Moltbook announcement author is invalid")
            ),
            createdAtMs: v.optional(moltbookTimestampSchema),
            postId: v.optional(moltbookIdentitySchema),
            previewText: v.optional(
                boundedTextSchema(2000, "Moltbook announcement preview is invalid")
            ),
            title: v.optional(moltbookTitleSchema),
        })
    ),
    nextActions: v.pipe(
        v.array(
            boundedDisplayTextSchema(300, "Moltbook next action is invalid"),
            "Moltbook next actions are invalid"
        ),
        v.maxLength(
            moltbookNextActionsMaximum,
            "Moltbook next actions are outside their row budget"
        )
    ),
    pendingRequestCount: moltbookCountSchema,
    postsFromAccountsYouFollowCount: moltbookCountSchema,
    unreadMessageCount: moltbookCountSchema,
    unreadNotificationCount: moltbookCountSchema,
});

/** One all-or-nothing last-known-good projection from the four fixed Moltbook reads. */
export const moltbookDashboardCachePayloadSchema = v.strictObject({
    feeds: v.strictObject({
        hot: moltbookFeedSchema,
        new: moltbookFeedSchema,
    }),
    fetchedAtMs: moltbookTimestampSchema,
    home: moltbookHomeSchema,
    myContent: moltbookOwnContentSchema,
    profile: v.optional(moltbookProfileSchema),
});

export type MoltbookDashboardCachePayload = v.InferOutput<
    typeof moltbookDashboardCachePayloadSchema
>;
export type MoltbookFeed = v.InferOutput<typeof moltbookFeedSchema>;
export type MoltbookFeedPost = v.InferOutput<typeof moltbookFeedPostSchema>;
export type MoltbookHome = v.InferOutput<typeof moltbookHomeSchema>;
export type MoltbookOwnComment = v.InferOutput<typeof moltbookOwnCommentSchema>;
export type MoltbookOwnContent = v.InferOutput<typeof moltbookOwnContentSchema>;
export type MoltbookOwnPost = v.InferOutput<typeof moltbookOwnPostSchema>;
export type MoltbookProfile = v.InferOutput<typeof moltbookProfileSchema>;

const moltbookSnapshotStatusEntries = {
    freshness: v.picklist(["fresh", "stale"], "Moltbook freshness is invalid"),
    lastAttemptAtMs: moltbookTimestampSchema,
    lastSuccessAtMs: moltbookTimestampSchema,
};

export const moltbookSnapshotStatusSchema = v.variant("lastAttemptStatus", [
    v.strictObject({
        ...moltbookSnapshotStatusEntries,
        lastAttemptStatus: v.literal("failed"),
        refreshFailureMessage: boundedDisplayTextSchema(
            2000,
            "Moltbook refresh failure is invalid"
        ),
    }),
    v.strictObject({
        ...moltbookSnapshotStatusEntries,
        lastAttemptStatus: v.literal("succeeded"),
    }),
]);

export const moltbookHomeResultSchema = v.strictObject({
    home: moltbookHomeSchema,
    status: moltbookSnapshotStatusSchema,
});
export const moltbookFeedInputSchema = v.strictObject({
    sort: v.optional(v.picklist(["hot", "new"], "Moltbook feed sort is invalid"), "hot"),
});
export const moltbookFeedResultSchema = v.strictObject({
    feed: moltbookFeedSchema,
    status: moltbookSnapshotStatusSchema,
});
export const moltbookProfileResultSchema = v.strictObject({
    profile: v.optional(moltbookProfileSchema),
    status: moltbookSnapshotStatusSchema,
});
export const moltbookOwnContentResultSchema = v.strictObject({
    content: moltbookOwnContentSchema,
    status: moltbookSnapshotStatusSchema,
});

export type MoltbookFeedInput = v.InferOutput<typeof moltbookFeedInputSchema>;
export type MoltbookFeedResult = v.InferOutput<typeof moltbookFeedResultSchema>;
export type MoltbookHomeResult = v.InferOutput<typeof moltbookHomeResultSchema>;
export type MoltbookOwnContentResult = v.InferOutput<
    typeof moltbookOwnContentResultSchema
>;
export type MoltbookProfileResult = v.InferOutput<typeof moltbookProfileResultSchema>;
export type MoltbookSnapshotStatus = v.InferOutput<typeof moltbookSnapshotStatusSchema>;

const moltbookReadAccess = Object.freeze({
    capabilities: ["cache:read"] as const,
    capabilityPolicy: "all" as const,
    kind: "authenticated" as const,
    principalKinds: ["session"] as const,
});
const moltbookReadErrors = ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"] as const;
const moltbookReadTransport = Object.freeze({
    batching: "adapter-default" as const,
    handler: "default" as const,
    requestBody: "default" as const,
});

/** Capability-scoped read-only Moltbook procedure metadata. */
export const moltbookProcedureContracts = [
    {
        access: moltbookReadAccess,
        domain: "moltbook",
        errors: moltbookReadErrors,
        input: moltbookFeedInputSchema,
        inputSchemaId: "moltbook.feed.input.v1",
        kind: "query",
        name: "moltbook.feed",
        output: moltbookFeedResultSchema,
        outputSchemaId: "moltbook.feed.result.v1",
        summary: "Reads one sorted feed from the bounded Moltbook snapshot.",
        transport: moltbookReadTransport,
    },
    {
        access: moltbookReadAccess,
        domain: "moltbook",
        errors: moltbookReadErrors,
        input: emptyInputSchema,
        inputSchemaId: "system.empty.v1",
        kind: "query",
        name: "moltbook.home",
        output: moltbookHomeResultSchema,
        outputSchemaId: "moltbook.home.result.v1",
        summary: "Reads bounded Moltbook activity counts and notification status.",
        transport: moltbookReadTransport,
    },
    {
        access: moltbookReadAccess,
        domain: "moltbook",
        errors: moltbookReadErrors,
        input: emptyInputSchema,
        inputSchemaId: "system.empty.v1",
        kind: "query",
        name: "moltbook.listMyPosts",
        output: moltbookOwnContentResultSchema,
        outputSchemaId: "moltbook.own-content.result.v1",
        summary: "Reads bounded posts and comments authored by the configured agent.",
        transport: moltbookReadTransport,
    },
    {
        access: moltbookReadAccess,
        domain: "moltbook",
        errors: moltbookReadErrors,
        input: emptyInputSchema,
        inputSchemaId: "system.empty.v1",
        kind: "query",
        name: "moltbook.profile",
        output: moltbookProfileResultSchema,
        outputSchemaId: "moltbook.profile.result.v1",
        summary: "Reads the configured agent's bounded Moltbook profile.",
        transport: moltbookReadTransport,
    },
] as const satisfies readonly ProcedureContract[];
