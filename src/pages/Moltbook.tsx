import { formatDistanceToNow } from "date-fns";
import { nb } from "date-fns/locale";
import {
    Clock,
    ExternalLink,
    FileText,
    Flame,
    MessageCircle,
    MessageSquare,
    RefreshCw,
    Star,
    User,
    Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import { getFeed, getHome, type MoltbookHome, type MoltbookPost } from "../api/moltbook";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";

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
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: nb });
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
                        href={MOLTBOOK_URL + "/u/mira_2026"}
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
                    <div className="flex items-start gap-4">
                        <a
                            href={MOLTBOOK_URL + "/u/mira_2026"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-indigo-500/20 transition hover:ring-2 hover:ring-indigo-400"
                        >
                            {profile.avatar_url ? (
                                <img
                                    src={profile.avatar_url}
                                    alt={profile.name}
                                    className="h-full w-full object-cover"
                                />
                            ) : (
                                <User className="h-7 w-7 text-indigo-400" />
                            )}
                        </a>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <a
                                    href={MOLTBOOK_URL + "/u/mira_2026"}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-lg font-semibold text-slate-100 transition hover:text-indigo-300"
                                >
                                    {profile.display_name || profile.name}
                                </a>
                                {unreadCount > 0 && (
                                    <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs text-red-400">
                                        {unreadCount} new
                                    </span>
                                )}
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-sm text-slate-400">
                                {profile.description}
                            </p>
                            <div className="mt-2 flex items-center gap-4 text-sm">
                                <span className="flex items-center gap-1 text-slate-300">
                                    <Star className="h-3.5 w-3.5 text-yellow-400" />
                                    <span className="font-medium">{profile.karma}</span>
                                    <span className="text-slate-500">karma</span>
                                </span>
                                <span className="flex items-center gap-1 text-slate-300">
                                    <Users className="h-3.5 w-3.5" />
                                    <span className="font-medium">
                                        {profile.follower_count}
                                    </span>
                                    <span className="text-slate-500">followers</span>
                                </span>
                                <span className="flex items-center gap-1 text-slate-300">
                                    <User className="h-3.5 w-3.5" />
                                    <span className="font-medium">
                                        {profile.following_count}
                                    </span>
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
                                <Card key={post.id} className="p-3">
                                    <div className="flex items-center gap-3">
                                        {/* Vote count - vertically centered */}
                                        <div className="flex min-w-[2.5rem] items-center justify-center">
                                            <span className="text-sm font-medium text-slate-300">
                                                {post.upvotes - post.downvotes}
                                            </span>
                                        </div>

                                        {/* Content */}
                                        <div className="min-w-0 flex-1">
                                            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                                                <a
                                                    href={
                                                        MOLTBOOK_URL +
                                                        "/m/" +
                                                        post.submolt_name
                                                    }
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="font-medium text-indigo-400 hover:text-indigo-300"
                                                >
                                                    m/{post.submolt_name}
                                                </a>
                                                <span>•</span>
                                                <a
                                                    href={
                                                        MOLTBOOK_URL +
                                                        "/u/" +
                                                        post.author.name
                                                    }
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
                                                <h3 className="line-clamp-2 text-base font-medium text-slate-100 transition group-hover:text-indigo-300">
                                                    {post.title}
                                                </h3>
                                                <p className="mt-1 line-clamp-2 text-sm text-slate-400 transition group-hover:text-slate-300">
                                                    {post.content_preview || post.content}
                                                </p>
                                            </a>
                                            <div className="mt-2 flex items-center gap-4 text-xs text-slate-500">
                                                <a
                                                    href={
                                                        MOLTBOOK_URL + "/post/" + post.id
                                                    }
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="flex items-center gap-1 transition hover:text-slate-200"
                                                >
                                                    <MessageSquare className="h-3 w-3" />
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
                                <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
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
                                    <h3 className="text-base font-medium text-slate-100 transition group-hover:text-indigo-300">
                                        {post.title}
                                    </h3>
                                    <p className="mt-1 line-clamp-2 text-sm text-slate-400 transition group-hover:text-slate-300">
                                        {post.content_preview}
                                    </p>
                                </a>
                                <div className="mt-2 flex items-center gap-4 text-sm">
                                    <span className="text-orange-400">
                                        ↑ {post.upvotes}
                                    </span>
                                    <span className="text-slate-500">
                                        ↓ {post.downvotes}
                                    </span>
                                    <a
                                        href={MOLTBOOK_URL + "/post/" + post.id}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-1 text-slate-400 hover:text-slate-200"
                                    >
                                        <MessageSquare className="h-3 w-3" />
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
                                <div className="mb-1 text-xs text-slate-500">
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
                                    href={
                                        MOLTBOOK_URL +
                                        "/post/" +
                                        comment.post.id +
                                        "#comment-" +
                                        comment.id
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group block"
                                >
                                    <p className="text-sm text-slate-300 transition group-hover:text-white">
                                        {truncate(comment.content, 300)}
                                    </p>
                                </a>
                                <div className="mt-2 flex items-center gap-4 text-sm text-slate-500">
                                    <span className="text-orange-400">
                                        ↑ {comment.upvotes}
                                    </span>
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
