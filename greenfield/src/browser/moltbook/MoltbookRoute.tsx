import { useQueries, useQueryClient } from "@tanstack/react-query";
import { Flame, MessageCircle, MessageSquare, Newspaper, RotateCw } from "lucide-react";
import { useState } from "react";

import type {
    MoltbookFeedPost,
    MoltbookOwnComment,
    MoltbookOwnPost,
    MoltbookSnapshotStatus,
} from "../../contracts/moltbook.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
    MoltbookFeedPostCard,
    MoltbookOwnCommentCard,
    MoltbookOwnPostCard,
    MoltbookProfileCard,
} from "./MoltbookCards.tsx";
import {
    moltbookFeedQueryOptions,
    moltbookHomeQueryOptions,
    moltbookOwnContentQueryOptions,
    moltbookProfileQueryOptions,
    refreshMoltbookQueries,
} from "./moltbookQueries.ts";

function MoltbookSnapshotNotice({ status }: { readonly status: MoltbookSnapshotStatus }) {
    if (status.freshness === "fresh" && status.lastAttemptStatus === "succeeded") {
        return null;
    }
    const message =
        status.lastAttemptStatus === "failed"
            ? (status.refreshFailureMessage ??
              "The latest Moltbook refresh failed; showing last-known-good data.")
            : "Moltbook data is stale; showing the last-known-good snapshot.";
    return <Alert focusOnError={false} message={message} variant="info" />;
}

function MoltbookSnapshotBadge({ status }: { readonly status: MoltbookSnapshotStatus }) {
    const isCurrent =
        status.freshness === "fresh" && status.lastAttemptStatus === "succeeded";
    return (
        <Badge variant={isCurrent ? "success" : "warning"}>
            {isCurrent ? "Fresh snapshot" : "Last-known-good snapshot"}
        </Badge>
    );
}

function MoltbookFeedList({ posts }: { readonly posts: readonly MoltbookFeedPost[] }) {
    return posts.length === 0 ? (
        <EmptyState title="No posts yet." />
    ) : (
        <div className="space-y-3">
            {posts.map((post) => (
                <MoltbookFeedPostCard key={post.id} post={post} />
            ))}
        </div>
    );
}

function MoltbookOwnPostList({ posts }: { readonly posts: readonly MoltbookOwnPost[] }) {
    return posts.length === 0 ? (
        <EmptyState title="No posts yet." />
    ) : (
        <div className="space-y-3">
            {posts.map((post) => (
                <MoltbookOwnPostCard key={post.id} post={post} />
            ))}
        </div>
    );
}

function MoltbookOwnCommentList({
    comments,
}: {
    readonly comments: readonly MoltbookOwnComment[];
}) {
    return comments.length === 0 ? (
        <EmptyState title="No comments yet." />
    ) : (
        <div className="space-y-3">
            {comments.map((comment) => (
                <MoltbookOwnCommentCard comment={comment} key={comment.id} />
            ))}
        </div>
    );
}

/** @returns Read-only Moltbook profile, feed, posts, and comments from durable LKG state. */
export function MoltbookRoute() {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [content, setContent] = useState<"comments" | "feed" | "posts">("feed");
    const [sort, setSort] = useState<"hot" | "new">("hot");
    const [homeQuery, feedQuery, profileQuery, ownContentQuery] = useQueries({
        queries: [
            moltbookHomeQueryOptions(client),
            moltbookFeedQueryOptions(client, sort),
            moltbookProfileQueryOptions(client),
            moltbookOwnContentQueryOptions(client),
        ],
    });
    const data = {
        feed: feedQuery.data,
        home: homeQuery.data,
        ownContent: ownContentQuery.data,
        profile: profileQuery.data,
    };
    const firstError =
        homeQuery.error ?? feedQuery.error ?? profileQuery.error ?? ownContentQuery.error;
    const complete = Object.values(data).every((value) => value !== undefined);
    const loading = [homeQuery, feedQuery, profileQuery, ownContentQuery].some(
        (query) => query.isPending
    );
    const fetching = [homeQuery, feedQuery, profileQuery, ownContentQuery].some(
        (query) => query.isFetching
    );
    const refresh = () => void refreshMoltbookQueries(queryClient);

    return (
        <div>
            <PageHeader
                actions={
                    <Button
                        busy={fetching}
                        busyLabel="Refreshing Moltbook…"
                        onClick={refresh}
                        variant="secondary"
                    >
                        <Icon icon={RotateCw} size="sm" tone="inherit" />
                        Retry
                    </Button>
                }
                description="Read the configured agent's bounded Moltbook profile, feeds, posts, and comments from a durable worker-owned snapshot."
                eyebrow="Community"
                title="Moltbook"
            />
            <div className="mt-8">
                {loading && !complete ? (
                    <PageState label="Loading Moltbook…" size="lg" status="loading" />
                ) : null}
                {!loading && firstError !== null && !complete ? (
                    <PageState
                        message={dashboardBrowserFailureMessage(firstError)}
                        onRetry={refresh}
                        retryBusy={fetching}
                        retryLabel="Retry"
                        status="error"
                        title="Moltbook unavailable"
                    />
                ) : null}
                {complete ? (
                    <PageState status="ready">
                        <div className="space-y-6">
                            <MoltbookSnapshotNotice status={data.home!.status} />
                            <MoltbookSnapshotBadge status={data.home!.status} />
                            {data.profile!.profile === undefined ? null : (
                                <MoltbookProfileCard
                                    home={data.home!.home}
                                    profile={data.profile!.profile}
                                />
                            )}
                            <Tabs
                                ariaLabel="Moltbook content"
                                onChange={setContent}
                                tabs={[
                                    {
                                        label: (
                                            <span className="inline-flex items-center gap-2">
                                                <Icon icon={Newspaper} size="sm" /> Feed
                                            </span>
                                        ),
                                        panel: (
                                            <Tabs
                                                ariaLabel="Moltbook feed sort"
                                                className="mt-4"
                                                onChange={setSort}
                                                tabs={[
                                                    {
                                                        label: (
                                                            <span className="inline-flex items-center gap-2">
                                                                <Icon
                                                                    icon={Flame}
                                                                    size="sm"
                                                                />{" "}
                                                                Hot
                                                            </span>
                                                        ),
                                                        panel: (
                                                            <MoltbookFeedList
                                                                posts={
                                                                    data.feed!.feed.posts
                                                                }
                                                            />
                                                        ),
                                                        value: "hot",
                                                    },
                                                    {
                                                        label: "New",
                                                        panel: (
                                                            <MoltbookFeedList
                                                                posts={
                                                                    data.feed!.feed.posts
                                                                }
                                                            />
                                                        ),
                                                        value: "new",
                                                    },
                                                ]}
                                                value={sort}
                                            />
                                        ),
                                        value: "feed",
                                    },
                                    {
                                        label: (
                                            <span className="inline-flex items-center gap-2">
                                                <Icon icon={MessageSquare} size="sm" />{" "}
                                                Posts
                                            </span>
                                        ),
                                        panel: (
                                            <MoltbookOwnPostList
                                                posts={data.ownContent!.content.posts}
                                            />
                                        ),
                                        value: "posts",
                                    },
                                    {
                                        label: (
                                            <span className="inline-flex items-center gap-2">
                                                <Icon icon={MessageCircle} size="sm" />{" "}
                                                Comments
                                            </span>
                                        ),
                                        panel: (
                                            <MoltbookOwnCommentList
                                                comments={
                                                    data.ownContent!.content.comments
                                                }
                                            />
                                        ),
                                        value: "comments",
                                    },
                                ]}
                                value={content}
                            />
                        </div>
                    </PageState>
                ) : null}
            </div>
        </div>
    );
}
