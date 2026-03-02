// Moltbook API client - proxies through backend

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

// Get home feed with notifications
export async function getHome(): Promise<MoltbookHome> {
    const response = await fetch("/api/moltbook/home", {
        headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
        const error = await response
            .json()
            .catch(() => ({ error: "Failed to fetch home" }));
        throw new Error(error.error || "Failed to fetch home feed");
    }
    return response.json();
}

// Get feed with optional sort
export async function getFeed(sort?: "hot" | "new"): Promise<MoltbookPost[]> {
    const url = sort ? `/api/moltbook/feed?sort=${sort}` : "/api/moltbook/feed";
    const response = await fetch(url, {
        headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
        const error = await response
            .json()
            .catch(() => ({ error: "Failed to fetch feed" }));
        throw new Error(error.error || "Failed to fetch feed");
    }
    const data = await response.json();
    const rawPosts = Array.isArray(data) ? data : data.posts || [];
    return rawPosts.map(transformPost);
}
