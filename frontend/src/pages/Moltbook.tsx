import { Flame, MessageCircle, MessageSquare, Newspaper, RefreshCw } from "lucide-react";
import { useState } from "react";

import { FeedPostCard } from "../components/features/moltbook/FeedPostCard";
import { MyCommentCard } from "../components/features/moltbook/MyCommentCard";
import { MyPostCard } from "../components/features/moltbook/MyPostCard";
import { ProfileCard } from "../components/features/moltbook/ProfileCard";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FilterButtonGroup } from "../components/ui/FilterButtonGroup";
import { LoadingState } from "../components/ui/LoadingState";
import { useMoltbookData } from "../hooks/useMoltbook";

const TAB_OPTIONS = [
    { value: "feed", label: "Feed", icon: <Newspaper className="size-4" /> },
    { value: "posts", label: "Posts", icon: <MessageSquare className="size-4" /> },
    {
        value: "comments",
        label: "Comments",
        icon: <MessageCircle className="size-4" />,
    },
] as const;

const SORT_OPTIONS = [
    { value: "hot", label: "Hot", icon: <Flame className="size-4" /> },
    { value: "new", label: "New", icon: <Newspaper className="size-4" /> },
] as const;

/**
 * Renders the moltbook UI.
 * @returns Rendered the moltbook UI.
 */
export function Moltbook() {
    const [sort, setSort] = useState<"hot" | "new">("hot");
    const [activeTab, setActiveTab] = useState<"feed" | "posts" | "comments">("feed");

    const { home, posts, profile, myContent, isLoading, error, refetch } =
        useMoltbookData(sort);

    if (isLoading) {
        return <LoadingState message="Loading Moltbook..." size="lg" />;
    }

    if (error) {
        return (
            <div className="flex h-64 flex-col items-center justify-center gap-4 p-3 sm:p-4 lg:p-6">
                <p className="text-red-400">{error}</p>
                <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                        void refetch();
                    }}
                >
                    <RefreshCw className="size-4" />
                    Retry
                </Button>
            </div>
        );
    }

    const unreadCount = home?.unreadMessageCount ?? 0;

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:space-y-6 lg:p-6">
            {/* Profile Stats Card */}
            {profile && (
                <Card className="p-3 sm:p-4">
                    <ProfileCard profile={profile} unreadCount={unreadCount} />
                </Card>
            )}

            {/* Tabs */}
            <div>
                <FilterButtonGroup
                    ariaLabel="Moltbook content"
                    options={TAB_OPTIONS}
                    value={activeTab}
                    onChange={(v) => setActiveTab(v)}
                    className="w-full [&>button]:flex-1 sm:[&>button]:flex-none"
                />
            </div>

            {/* Feed Tab */}
            {activeTab === "feed" && (
                <div className="space-y-4 lg:space-y-6">
                    <FilterButtonGroup
                        ariaLabel="Moltbook feed sort"
                        options={SORT_OPTIONS}
                        value={sort}
                        onChange={(v) => setSort(v)}
                        className="w-full [&>button]:flex-1 sm:[&>button]:flex-none"
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
                </div>
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
