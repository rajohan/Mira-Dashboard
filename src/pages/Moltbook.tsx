import { Clock, ExternalLink, FileText, Flame, MessageCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { getFeed, getHome, type MoltbookPost, type MoltbookHome } from "../api/moltbook";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ProfileCard, FeedPostCard, MyPostCard, MyCommentCard } from "../components/features/moltbook";
import { type MiraProfile, type MiraContent } from "../types/moltbook";
import { getMoltbookUrl } from "../utils/moltbookUtils";

export function Moltbook() {
    const [posts, setPosts] = useState<MoltbookPost[]>([]);
    const [homeData, setHomeData] = useState<MoltbookHome | null>(null);
    const [profile, setProfile] = useState<MiraProfile | null>(null);
    const [myContent, setMyContent] = useState<MiraContent | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [sort, setSort] = useState<"hot" | "new">("hot");
    const [activeTab, setActiveTab] = useState<"feed" | "posts" | "comments">("feed");

    const unreadCount = homeData?.your_account?.unread_notification_count
        ? Number.parseInt(homeData.your_account.unread_notification_count)
        : 0;

    const fetchData = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [homeResponse, feedPosts, profileRes, contentRes] = await Promise.all([
                getHome(),
                getFeed(sort),
                fetch("/api/moltbook/profile").then((r) => r.json()),
                fetch("/api/moltbook/my-posts").then((r) => r.json()),
            ]);
            setHomeData(homeResponse);
            setPosts(feedPosts);
            if (profileRes.agent) {
                setProfile(profileRes.agent);
            }
            if (contentRes.posts) {
                setMyContent(contentRes);
            }
        } catch (error_) {
            setError(error_ instanceof Error ? error_.message : "Failed to load");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, [sort]);

    if (isLoading) {
        return (
            <div className="flex h-64 items-center justify-center p-6">
                <RefreshCw className="h-6 w-6 animate-spin text-slate-400" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6">
                <Card className="p-6">
                    <div className="text-center text-red-400">
                        <p>{error}</p>
                        <Button onClick={fetchData} className="mt-4">
                            Retry
                        </Button>
                    </div>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-6 p-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold">Moltbook</h1>
                <div className="flex items-center gap-3">
                    <a
                        href={getMoltbookUrl("/u/mira_2026")}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-indigo-400 hover:text-indigo-300"
                    >
                        View Profile
                        <ExternalLink className="h-3 w-3" />
                    </a>
                    <Button variant="secondary" size="sm" onClick={fetchData}>
                        <RefreshCw className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Profile Stats Card */}
            {profile && (
                <Card className="p-4">
                    <ProfileCard profile={profile} unreadCount={unreadCount} />
                </Card>
            )}

            {/* Tabs */}
            <div className="flex gap-2 border-b border-slate-700 pb-2">
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
                    <FileText className="mr-1 h-4 w-4" />
                    My Posts ({profile?.posts_count || 0})
                </Button>
                <Button
                    variant={activeTab === "comments" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setActiveTab("comments")}
                >
                    <MessageCircle className="mr-1 h-4 w-4" />
                    My Comments ({profile?.comments_count || 0})
                </Button>
            </div>

            {/* Feed Tab */}
            {activeTab === "feed" && (
                <>
                    {/* Sort Tabs */}
                    <div className="flex gap-2">
                        <Button
                            variant={sort === "hot" ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setSort("hot")}
                        >
                            <Flame className="mr-1 h-4 w-4" />
                            Hot
                        </Button>
                        <Button
                            variant={sort === "new" ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setSort("new")}
                        >
                            <Clock className="mr-1 h-4 w-4" />
                            New
                        </Button>
                    </div>

                    {/* Posts */}
                    <div className="space-y-3">
                        {posts.length === 0 ? (
                            <Card className="p-6 text-center text-slate-400">
                                <p>No posts yet.</p>
                            </Card>
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
                        <Card className="p-6 text-center text-slate-400">
                            <p>No posts yet.</p>
                        </Card>
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
                        <Card className="p-6 text-center text-slate-400">
                            <p>No comments yet.</p>
                        </Card>
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