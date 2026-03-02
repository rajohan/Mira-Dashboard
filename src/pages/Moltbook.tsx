import { useEffect, useState } from "react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import {
    RefreshCw,
    MessageSquare,
    Flame,
    Clock,
    User,
    Users,
    Star,
    FileText,
    MessageCircle,
    ExternalLink,
} from "lucide-react";
import {
    getHome,
    getFeed,
    type MoltbookPost,
    type MoltbookHome,
} from "../api/moltbook";

interface MiraProfile {
    name: string;
    display_name: string;
    description: string;
    karma: number;
    follower_count: number;
    following_count: number;
    posts_count: number;
    comments_count: number;
    avatar_url: string | null;
}

interface MiraContent {
    posts: Array<{
        id: string;
        title: string;
        content_preview: string;
        upvotes: number;
        downvotes: number;
        comment_count: number;
        created_at: string;
        submolt: { name: string };
    }>;
    comments: Array<{
        id: string;
        content: string;
        upvotes: number;
        downvotes: number;
        created_at: string;
        post: { id: string; title: string; submolt: { name: string } };
    }>;
}

const MOLTBOOK_URL = "https://www.moltbook.com";

function formatTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return diffDays + "d ago";
    if (diffHours > 0) return diffHours + "h ago";
    if (diffMins < 1) return "just now";
    return diffMins + "m ago";
}

function truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + "...";
}

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
        ? parseInt(homeData.your_account.unread_notification_count)
        : 0;

    const fetchData = async () => {
        setIsLoading(true);
        setError(null);
        try {
            const [homeResponse, feedPosts, profileRes, contentRes] = await Promise.all([
                getHome(),
                getFeed(sort),
                fetch("/api/moltbook/profile").then(r => r.json()),
                fetch("/api/moltbook/my-posts").then(r => r.json()),
            ]);
            setHomeData(homeResponse);
            setPosts(feedPosts);
            if (profileRes.agent) {
                setProfile(profileRes.agent);
            }
            if (contentRes.posts) {
                setMyContent(contentRes);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Failed to load");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchData();
    }, [sort]);

    if (isLoading) {
        return (
            <div className="p-6 flex items-center justify-center h-64">
                <RefreshCw className="w-6 h-6 animate-spin text-slate-400" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6">
                <Card className="p-6">
                    <div className="text-red-400 text-center">
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
        <div className="p-6 space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-bold">Moltbook</h1>
                <div className="flex items-center gap-3">
                    <a
                        href={MOLTBOOK_URL + "/u/mira_2026"}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                    >
                        View Profile
                        <ExternalLink className="w-3 h-3" />
                    </a>
                    <Button variant="secondary" size="sm" onClick={fetchData}>
                        <RefreshCw className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            {/* Profile Stats Card */}
            {profile && (
                <Card className="p-4">
                    <div className="flex items-start gap-4">
                        <a
                            href={MOLTBOOK_URL + "/u/mira_2026"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-14 h-14 rounded-full bg-indigo-500/20 flex items-center justify-center overflow-hidden flex-shrink-0 hover:ring-2 hover:ring-indigo-400 transition"
                        >
                            {profile.avatar_url ? (
                                <img src={profile.avatar_url} alt={profile.name} className="w-full h-full object-cover" />
                            ) : (
                                <User className="w-7 h-7 text-indigo-400" />
                            )}
                        </a>
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <a
                                    href={MOLTBOOK_URL + "/u/mira_2026"}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-lg font-semibold text-slate-100 hover:text-indigo-300 transition"
                                >
                                    {profile.display_name || profile.name}
                                </a>
                                {unreadCount > 0 && (
                                    <span className="bg-red-500/20 text-red-400 text-xs px-2 py-0.5 rounded-full">
                                        {unreadCount} new
                                    </span>
                                )}
                            </div>
                            <p className="text-sm text-slate-400 mt-0.5 line-clamp-2">{profile.description}</p>
                            <div className="flex items-center gap-4 mt-2 text-sm">
                                <span className="flex items-center gap-1 text-slate-300">
                                    <Star className="w-3.5 h-3.5 text-yellow-400" />
                                    <span className="font-medium">{profile.karma}</span>
                                    <span className="text-slate-500">karma</span>
                                </span>
                                <span className="flex items-center gap-1 text-slate-300">
                                    <Users className="w-3.5 h-3.5" />
                                    <span className="font-medium">{profile.follower_count}</span>
                                    <span className="text-slate-500">followers</span>
                                </span>
                                <span className="flex items-center gap-1 text-slate-300">
                                    <User className="w-3.5 h-3.5" />
                                    <span className="font-medium">{profile.following_count}</span>
                                    <span className="text-slate-500">following</span>
                                </span>
                            </div>
                        </div>
                    </div>
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
                    <FileText className="w-4 h-4 mr-1" />
                    My Posts ({profile?.posts_count || 0})
                </Button>
                <Button
                    variant={activeTab === "comments" ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setActiveTab("comments")}
                >
                    <MessageCircle className="w-4 h-4 mr-1" />
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
                            <Flame className="w-4 h-4 mr-1" />
                            Hot
                        </Button>
                        <Button
                            variant={sort === "new" ? "primary" : "secondary"}
                            size="sm"
                            onClick={() => setSort("new")}
                        >
                            <Clock className="w-4 h-4 mr-1" />
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
                                <Card key={post.id} className="p-3">
                                    <div className="flex gap-3 items-center">
                                        {/* Vote count - vertically centered */}
                                        <div className="flex items-center justify-center min-w-[2.5rem]">
                                            <span className="text-sm font-medium text-slate-300">
                                                {post.upvotes - post.downvotes}
                                            </span>
                                        </div>

                                        {/* Content */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                                                <a
                                                    href={MOLTBOOK_URL + "/m/" + post.submolt_name}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-indigo-400 hover:text-indigo-300 font-medium"
                                                >
                                                    m/{post.submolt_name}
                                                </a>
                                                <span>•</span>
                                                <a
                                                    href={MOLTBOOK_URL + "/u/" + post.author.name}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-slate-400 hover:text-slate-300"
                                                >
                                                    {post.author.name}
                                                </a>
                                                <span>•</span>
                                                <span>{formatTime(post.created_at)}</span>
                                            </div>
                                            <a
                                                href={MOLTBOOK_URL + "/post/" + post.id}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="group block"
                                            >
                                                <h3 className="text-base font-medium text-slate-100 group-hover:text-indigo-300 transition line-clamp-2">
                                                    {post.title}
                                                </h3>
                                                <p className="text-sm text-slate-400 group-hover:text-slate-300 transition line-clamp-2 mt-1">
                                                    {post.content_preview || post.content}
                                                </p>
                                            </a>
                                            <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                                                <a
                                                    href={MOLTBOOK_URL + "/post/" + post.id}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center gap-1 hover:text-slate-200 transition"
                                                >
                                                    <MessageSquare className="w-3 h-3" />
                                                    {post.comment_count} comments
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                </Card>
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
                            <Card key={post.id} className="p-3">
                                <div className="flex items-center gap-2 text-xs text-slate-500 mb-1">
                                    <a
                                        href={MOLTBOOK_URL + "/m/" + post.submolt.name}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-indigo-400 hover:text-indigo-300"
                                    >
                                        m/{post.submolt.name}
                                    </a>
                                    <span>•</span>
                                    <span>{formatTime(post.created_at)}</span>
                                </div>
                                <a
                                    href={MOLTBOOK_URL + "/post/" + post.id}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group block"
                                >
                                    <h3 className="text-base font-medium text-slate-100 group-hover:text-indigo-300 transition">{post.title}</h3>
                                    <p className="text-sm text-slate-400 group-hover:text-slate-300 transition line-clamp-2 mt-1">{post.content_preview}</p>
                                </a>
                                <div className="flex items-center gap-4 mt-2 text-sm">
                                    <span className="text-orange-400">↑ {post.upvotes}</span>
                                    <span className="text-slate-500">↓ {post.downvotes}</span>
                                    <a
                                        href={MOLTBOOK_URL + "/post/" + post.id}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-slate-400 hover:text-slate-200 flex items-center gap-1"
                                    >
                                        <MessageSquare className="w-3 h-3" />
                                        {post.comment_count}
                                    </a>
                                </div>
                            </Card>
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
                            <Card key={comment.id} className="p-3">
                                <div className="text-xs text-slate-500 mb-1">
                                    Commented on{" "}
                                    <a
                                        href={MOLTBOOK_URL + "/post/" + comment.post.id}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-indigo-400 hover:text-indigo-300"
                                    >
                                        {comment.post.title}
                                    </a>
                                    <span className="mx-2">•</span>
                                    {formatTime(comment.created_at)}
                                </div>
                                <a
                                    href={MOLTBOOK_URL + "/post/" + comment.post.id + "#comment-" + comment.id}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group block"
                                >
                                    <p className="text-slate-300 group-hover:text-white transition text-sm">{truncate(comment.content, 300)}</p>
                                </a>
                                <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
                                    <span className="text-orange-400">↑ {comment.upvotes}</span>
                                    <span>↓ {comment.downvotes}</span>
                                </div>
                            </Card>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
