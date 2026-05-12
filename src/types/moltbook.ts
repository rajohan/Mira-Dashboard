/** Represents mira profile. */
export interface MiraProfile {
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

/** Represents mira post. */
export interface MiraPost {
    id: string;
    title: string;
    content_preview: string;
    upvotes: number;
    downvotes: number;
    comment_count: number;
    created_at: string;
    submolt: { name: string };
}

/** Represents mira comment. */
export interface MiraComment {
    id: string;
    content: string;
    upvotes: number;
    downvotes: number;
    created_at: string;
    post: { id: string; title: string; submolt: { name: string } };
}

/** Represents mira content. */
export interface MiraContent {
    posts: MiraPost[];
    comments: MiraComment[];
}
