import { Clock, ExternalLink, FileText, Flame, MessageCircle, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ProfileCard, FeedPostCard, MyPostCard, MyCommentCard } from "../components/features/moltbook";
import { useMoltbookData } from "../hooks";

export function Moltbook() {
    const [sort, setSort] = useState<"hot" | "new">("hot");
    const [activeTab, setActiveTab] = useState<"feed" | "posts" | "comments">("feed");

    const { home, posts, profile, myContent, isLoading, error, refetch } = useMoltbookData(sort);

    const unreadCount = home?.your_account?.unread_notification_count
        ? Number.parseInt(home.your_account.unread_notification_count)
        : 0;

    if (isLoading) {
        return (
            <div className="flex h-64 items-center justify-center p-6">
                <RefreshCw className="h-6 w-6 animate-spin text-slate-400" />
            </div>
        );
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
        <div className="flex h-full flex-col p-6">
            {/* Header */}
            <div className="mb-4 flex items-center justify-between">
                <h1 className="text-2xl font-bold">Moltbook</h1>
                <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => refetch()}>
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                    <a
                        href="https://www.moltbook.com"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-accent-400 hover:text-accent-300"
                    >
                        <ExternalLink className="inline h-4 w-4" />
                    </a>
                </div>
            </div>

            {/* Tabs */}
            <div className="mb-4 flex gap-2">
                <Button
                    variant={activeTab === "feed" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setActiveTab("feed")}
                >
                    Feed
                </Button>
                <Button
                    variant={activeTab === "posts" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setActiveTab("posts")}
                >
                    My Posts
                </Button>
                <Button
                    variant={activeTab === "comments" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setActiveTab("comments")}
                >
                    My Comments
                </Button>
            </div>

            {/* Content */}
            <div className="flex flex-1 gap-4 overflow-hidden">
                {/* Main Feed */}
                <div className="flex-1 overflow-auto">
                    {activeTab === "feed" && (
                        <>
                            {/* Sort Controls */}
                            <div className="mb-4 flex gap-2">
                                <Button
                                    variant={sort === "hot" ? "primary" : "secondary"}
                                    size="sm"
                                    onClick={() => setSort("hot")}
                                >
                                    <Flame className="h-4 w-4" />
                                    Hot
                                </Button>
                                <Button
                                    variant={sort === "new" ? "primary" : "secondary"}
                                    size="sm"
                                    onClick={() => setSort("new")}
                                >
                                    <Clock className="h-4 w-4" />
                                    New
                                </Button>
                            </div>

                            {/* Posts */}
                            <div className="space-y-4">
                                {posts.map((post) => (
                                    <FeedPostCard key={post.id} post={post} />
                                ))}
                                {posts.length === 0 && (
                                    <p className="text-center text-slate-400">No posts found</p>
                                )}
                            </div>
                        </>
                    )}

                    {activeTab === "posts" && (
                        <div className="space-y-4">
                            {myContent?.posts?.map((post) => (
                                <MyPostCard key={post.id} post={post} />
                            ))}
                            {(!myContent?.posts || myContent.posts.length === 0) && (
                                <p className="text-center text-slate-400">No posts yet</p>
                            )}
                        </div>
                    )}

                    {activeTab === "comments" && (
                        <div className="space-y-4">
                            {myContent?.comments?.map((comment) => (
                                <MyCommentCard key={comment.id} comment={comment} />
                            ))}
                            {(!myContent?.comments || myContent.comments.length === 0) && (
                                <p className="text-center text-slate-400">No comments yet</p>
                            )}
                        </div>
                    )}
                </div>

                {/* Sidebar */}
                <div className="w-80 flex-shrink-0 space-y-4">
                    {/* Profile Card */}
                    {profile && <ProfileCard profile={profile} unreadCount={unreadCount} />}

                    {/* Activity Summary */}
                    {home && (
                        <Card className="p-4">
                            <h3 className="mb-3 text-sm font-medium text-slate-200">Activity</h3>
                            <div className="space-y-2 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-400">Karma</span>
                                    <span className="font-medium text-primary-100">{home.your_account?.karma || 0}</span>
                                </div>
                                {unreadCount > 0 && (
                                    <div className="flex items-center justify-between">
                                        <span className="text-slate-400">Notifications</span>
                                        <span className="font-medium text-accent-400">{unreadCount}</span>
                                    </div>
                                )}
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-400">Following</span>
                                    <span className="font-medium text-primary-100">
                                        {home.posts_from_accounts_you_follow?.total_following || 0}
                                    </span>
                                </div>
                            </div>
                        </Card>
                    )}

                    {/* Quick Links */}
                    <Card className="p-4">
                        <h3 className="mb-3 text-sm font-medium text-slate-200">Links</h3>
                        <div className="space-y-2">
                            <a
                                href="https://www.moltbook.com/m/mira_2026"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                            >
                                <FileText className="h-4 w-4" />
                                My Profile
                            </a>
                            <a
                                href="https://www.moltbook.com/notifications"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2 text-sm text-accent-400 hover:text-accent-300"
                            >
                                <MessageCircle className="h-4 w-4" />
                                Notifications
                                {unreadCount > 0 && (
                                    <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-xs text-white">
                                        {unreadCount}
                                    </span>
                                )}
                            </a>
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}