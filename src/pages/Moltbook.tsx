import { RefreshCw } from "lucide-react";
import { useState } from "react";

import {
    FeedPostCard,
    MyCommentCard,
    MyPostCard,
    ProfileCard,
} from "../components/features/moltbook";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { LoadingState } from "../components/ui/LoadingState";
import { useMoltbookData } from "../hooks";

const TAB_OPTIONS = [
    { value: "feed", label: "Feed" },
    { value: "posts", label: "Posts" },
    { value: "comments", label: "Comments" },
] as const;

const SORT_OPTIONS = [
    { value: "hot", label: "Hot" },
    { value: "new", label: "New" },
] as const;

export function Moltbook() {
    const [sort, setSort] = useState<"hot" | "new">("hot");
    const [activeTab, setActiveTab] = useState<"feed" | "posts" | "comments">("feed");

    const { home, posts, profile, myContent, isLoading, error, refetch } =
        useMoltbookData(sort);

    const unreadCount = home?.unreadMessageCount ?? 0;

    if (isLoading) {
        return <LoadingState size="lg" />;
    }

    if (error) {
        return (
            <div className="flex h-64 flex-col items-center justify-center gap-4 p-6">
                <p className="text-red-400">{error}</p>
                <Button variant="secondary" size="sm" onClick={() => refetch()}>
                    <RefreshCw className="h-4 w-4" />
                    Retry
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-6 p-6">
            {/* Profile Stats Card */}
            {profile && (
                <Card className="p-4">
                    <ProfileCard profile={profile} unreadCount={unreadCount} />
                </Card>
            )}

            {/* Tabs */}
            <FilterButtonGroup
                options={TAB_OPTIONS}
                value={activeTab}
                onChange={(v) => setActiveTab(v)}
            />

            {/* Feed Tab */}
            {activeTab === "feed" && (
                <>
                    <FilterButtonGroup
                        options={SORT_OPTIONS}
                        value={sort}
                        onChange={(v) => setSort(v)}
                    />

                    <div className="space-y-3">
                        {posts.length === 0 ? (
                            <EmptyState message="No posts yet." />
                        ) : (
                            posts.map((post) => (
                                <FeedPostCard key={post.id} post={post} />
                            ))
                        )}
                    </div>
                </>
            )}

            {/* My Posts Tab */}
            {activeTab === "posts" && (
                <div className="space-y-3">
                    {!myContent?.posts || myContent.posts.length === 0 ? (
                        <EmptyState message="No posts yet." />
                    ) : (
                        myContent.posts.map((post) => (
                            <MyPostCard key={post.id} post={post} />
                        ))
                    )}
                </div>
            )}

            {/* My Comments Tab */}
            {activeTab === "comments" && (
                <div className="space-y-3">
                    {!myContent?.comments || myContent.comments.length === 0 ? (
                        <EmptyState message="No comments yet." />
                    ) : (
                        myContent.comments.map((comment) => (
                            <MyCommentCard key={comment.id} comment={comment} />
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
