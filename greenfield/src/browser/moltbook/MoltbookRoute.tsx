import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Flame, MessageCircle, MessageSquare, Newspaper } from "lucide-react";
import { useState } from "react";

import type {
    MoltbookFeedPost,
    MoltbookOwnComment,
    MoltbookOwnPost,
    MoltbookSnapshotResult,
    MoltbookSnapshotStatus,
} from "../../contracts/moltbook.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Tabs } from "../ui/Tabs.tsx";
import {
    MoltbookFeedPostCard,
    MoltbookOwnCommentCard,
    MoltbookOwnPostCard,
    MoltbookProfileCard,
} from "./MoltbookCards.tsx";
import {
    moltbookSnapshotQueryKey,
    moltbookSnapshotQueryOptions,
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
    const snapshotQuery = useQuery(moltbookSnapshotQueryOptions(client, sort));
    const firstError = snapshotQuery.error;
    const retainedSort = sort === "hot" ? "new" : "hot";
    const retainedSnapshot = queryClient.getQueryData<MoltbookSnapshotResult>(
        moltbookSnapshotQueryKey(retainedSort)
    );
    const ready = snapshotQuery.data ?? retainedSnapshot;
    const complete = ready !== undefined;
    const loading = snapshotQuery.isPending;
    const fetching = snapshotQuery.isFetching;
    const refresh = () => void refreshMoltbookQueries(queryClient);

    return (
        <div>
            <h1 className="sr-only">Moltbook</h1>
            <div>
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
                            {firstError === null ? null : (
                                <div className="flex flex-wrap items-center gap-3">
                                    <Alert
                                        className="min-w-0 flex-1"
                                        focusOnError={false}
                                        message={
                                            ready.feed.sort === sort
                                                ? dashboardBrowserFailureMessage(
                                                      firstError
                                                  )
                                                : `The ${sort} feed could not be loaded; showing ${ready.feed.sort} feed data.`
                                        }
                                        variant="info"
                                    />
                                    <Button
                                        busy={fetching}
                                        onClick={refresh}
                                        variant="secondary"
                                    >
                                        Retry
                                    </Button>
                                </div>
                            )}
                            <MoltbookSnapshotNotice status={ready.status} />
                            {ready.profile === undefined ? null : (
                                <MoltbookProfileCard
                                    home={ready.home}
                                    profile={ready.profile}
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
                                                                posts={ready.feed.posts}
                                                            />
                                                        ),
                                                        value: "hot",
                                                    },
                                                    {
                                                        label: "New",
                                                        panel: (
                                                            <MoltbookFeedList
                                                                posts={ready.feed.posts}
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
                                                posts={ready.content.posts}
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
                                                comments={ready.content.comments}
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
