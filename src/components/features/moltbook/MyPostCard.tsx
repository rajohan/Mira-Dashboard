import { MessageSquare } from "lucide-react";

import { type MiraPost } from "../../../types/moltbook";
import { formatTime, getMoltbookUrl } from "../../../utils/moltbookUtils";
import { Card } from "../../ui/Card";

interface MyPostCardProps {
    post: MiraPost;
}

export function MyPostCard({ post }: MyPostCardProps) {
    return (
        <Card className="p-3">
            <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                <a
                    href={getMoltbookUrl("/m/" + post.submolt.name)}
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
                href={getMoltbookUrl("/post/" + post.id)}
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
                <span className="text-orange-400">↑ {post.upvotes}</span>
                <span className="text-slate-500">↓ {post.downvotes}</span>
                <a
                    href={getMoltbookUrl("/post/" + post.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-slate-400 hover:text-slate-200"
                >
                    <MessageSquare className="h-3 w-3" />
                    {post.comment_count}
                </a>
            </div>
        </Card>
    );
}
