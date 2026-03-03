import { useQuery } from "@tanstack/react-query";

import type { MiraComment, MiraContent, MiraPost, MiraProfile } from "../types/moltbook";

// Types
export interface MoltbookPost {
    id: string;
    title: string;
    content: string;
    content_preview?: string;
    author: { name: string; display_name?: string; avatar_url?: string };
    upvotes: number;
    downvotes: number;
    comment_count: number;
    created_at: string;
    submolt_name: string;
    you_follow_author?: boolean;
}

export interface MoltbookHome {
    your_account: {
        name: string;
        karma: number;
        unread_notification_count: string;
    };
    notifications: unknown[];
    activity_on_your_posts: unknown[];
    your_direct_messages: {
        pending_request_count: string;
        unread_message_count: string;
    };
    posts_from_accounts_you_follow: {
        posts: MoltbookPost[];
        total_following: number;
    };
}

interface ProfileResponse {
    agent?: MiraProfile;
}

interface MyContentResponse {
    posts: MiraPost[];
    comments: MiraComment[];
}

// Query keys
export const moltbookKeys = {
    home: (): ["moltbook", "home"] => ["moltbook", "home"],
    feed: (sort: "hot" | "new"): ["moltbook", "feed", string] => [
        "moltbook",
        "feed",
        sort,
    ],
    profile: (): ["moltbook", "profile"] => ["moltbook", "profile"],
    myContent: (): ["moltbook", "myContent"] => ["moltbook", "myContent"],
};

// Transform API post format to our format
function transformPost(apiPost: Record<string, unknown>): MoltbookPost {
    return {
        id: (apiPost.post_id || apiPost.id) as string,
        title: apiPost.title as string,
        content: (apiPost.content || apiPost.content_preview || "") as string,
        content_preview: apiPost.content_preview as string | undefined,
        author: {
            name: (apiPost.author_name ||
                (apiPost.author as Record<string, unknown>)?.name ||
                "unknown") as string,
            display_name: (apiPost.author as Record<string, unknown>)?.display_name as
                | string
                | undefined,
            avatar_url: (apiPost.author as Record<string, unknown>)?.avatar_url as
                | string
                | undefined,
        },
        upvotes: (apiPost.upvotes || 0) as number,
        downvotes: (apiPost.downvotes || 0) as number,
        comment_count: (apiPost.comment_count || 0) as number,
        created_at: apiPost.created_at as string,
        submolt_name: apiPost.submolt_name as string,
        you_follow_author: apiPost.you_follow_author as boolean | undefined,
    };
}

// Fetchers
async function fetchHome(): Promise<MoltbookHome> {
    const res = await fetch("/api/moltbook/home");
    if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Failed to fetch home" }));
        throw new Error(error.error || "Failed to fetch home feed");
    }
    return res.json();
}

async function fetchFeed(sort?: "hot" | "new"): Promise<MoltbookPost[]> {
    const url = sort ? `/api/moltbook/feed?sort=${sort}` : "/api/moltbook/feed";
    const res = await fetch(url);
    if (!res.ok) {
        const error = await res.json().catch(() => ({ error: "Failed to fetch feed" }));
        throw new Error(error.error || "Failed to fetch feed");
    }
    const data = await res.json();
    const rawPosts = Array.isArray(data) ? data : data.posts || [];
    return rawPosts.map(transformPost);
}

async function fetchProfile(): Promise<MiraProfile | null> {
    const res = await fetch("/api/moltbook/profile");
    if (!res.ok) throw new Error("Failed to fetch profile");
    const data: ProfileResponse = await res.json();
    return data.agent || null;
}

async function fetchMyContent(): Promise<MiraContent | null> {
    const res = await fetch("/api/moltbook/my-posts");
    if (!res.ok) throw new Error("Failed to fetch content");
    const data: MyContentResponse = await res.json();
    return { posts: data.posts || [], comments: data.comments || [] };
}

// Hooks
export function useMoltbookHome() {
    return useQuery({
        queryKey: moltbookKeys.home(),
        queryFn: fetchHome,
        staleTime: 60_000,
    });
}

export function useMoltbookFeed(sort: "hot" | "new" = "hot") {
    return useQuery({
        queryKey: moltbookKeys.feed(sort),
        queryFn: () => fetchFeed(sort),
        staleTime: 30_000,
    });
}

export function useMoltbookProfile() {
    return useQuery({
        queryKey: moltbookKeys.profile(),
        queryFn: fetchProfile,
        staleTime: 300_000,
    });
}

export function useMoltbookMyContent() {
    return useQuery({
        queryKey: moltbookKeys.myContent(),
        queryFn: fetchMyContent,
        staleTime: 60_000,
    });
}

// Combined hook for Moltbook page
export function useMoltbookData(sort: "hot" | "new" = "hot") {
    const home = useMoltbookHome();
    const feed = useMoltbookFeed(sort);
    const profile = useMoltbookProfile();
    const myContent = useMoltbookMyContent();

    const isLoading =
        home.isLoading || feed.isLoading || profile.isLoading || myContent.isLoading;
    const error = home.error || feed.error || profile.error || myContent.error;

    return {
        home: home.data,
        posts: feed.data || [],
        profile: profile.data,
        myContent: myContent.data,
        isLoading,
        error: error?.message || null,
        refetch: () => {
            home.refetch();
            feed.refetch();
            profile.refetch();
            myContent.refetch();
        },
    };
}
