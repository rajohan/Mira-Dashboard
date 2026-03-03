import { MessageSquare } from "lucide-react";

import { type MoltbookPost } from "../../../hooks/useMoltbook";
import { formatTime, getMoltbookUrl } from "../../../utils/moltbookUtils";
import { Card } from "../../ui/Card";

interface FeedPostCardProps {
    post: MoltbookPost;
}

export function FeedPostCard({ post }: FeedPostCardProps) {
    return (
        <Card className="p-3">
            <div className="flex items-center gap-3">
                <div className="flex min-w-[2.5rem] items-center justify-center">
                    <span className="text-sm font-medium text-slate-300">
                        {post.upvotes - post.downvotes}
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                        <a
                            href={getMoltbookUrl("/m/" + post.submolt_name)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-indigo-400 hover:text-indigo-300"
                        >
                            m/{post.submolt_name}
                        </a>
                        <span>•</span>
                        <a
                            href={getMoltbookUrl("/u/" + post.author.name)}
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
                        href={getMoltbookUrl("/post/" + post.id)}
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
                            href={getMoltbookUrl("/post/" + post.id)}
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
    );
}
