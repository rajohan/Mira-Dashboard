import type { MiraComment, MiraContent, MiraPost, MiraProfile } from "../types/moltbook";
import { useCacheEntry } from "./useCache";

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
    pendingRequestCount: number;
    unreadMessageCount: number;
    activityOnYourPostsCount: number;
    activityOnYourPosts: unknown[];
    latestAnnouncement: {
        postId: string | null;
        title: string | null;
        authorName: string | null;
        createdAt: string | null;
        preview: string | null;
    } | null;
    postsFromAccountsYouFollowCount: number | null;
    exploreCount: number | null;
    nextActions: string[];
    fetchedAt: string;
}

interface MoltbookProfileCache {
    agent?: MiraProfile;
}

interface MyContentResponse {
    posts: MiraPost[];
    comments: MiraComment[];
}

interface MoltbookFeedResponse {
    posts?: Record<string, unknown>[];
}

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

export function useMoltbookHome() {
    return useCacheEntry<MoltbookHome>("moltbook.home", 60_000);
}

export function useMoltbookFeed(sort: "hot" | "new" = "hot") {
    return useCacheEntry<MoltbookFeedResponse>(`moltbook.feed.${sort}`, 60_000);
}

export function useMoltbookProfile() {
    return useCacheEntry<MoltbookProfileCache>("moltbook.profile", 60_000);
}

export function useMoltbookMyContent() {
    return useCacheEntry<MyContentResponse>("moltbook.my-content", 60_000);
}

export function useMoltbookData(sort: "hot" | "new" = "hot") {
    const home = useMoltbookHome();
    const feed = useMoltbookFeed(sort);
    const profile = useMoltbookProfile();
    const myContent = useMoltbookMyContent();

    const isLoading =
        home.isLoading || feed.isLoading || profile.isLoading || myContent.isLoading;
    const error = home.error || feed.error || profile.error || myContent.error;

    return {
        home: home.data?.data,
        homeCache: home.data,
        posts: (feed.data?.data.posts || []).map(transformPost),
        profile: profile.data?.data.agent || null,
        myContent: {
            posts: myContent.data?.data.posts || [],
            comments: myContent.data?.data.comments || [],
        } as MiraContent,
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
