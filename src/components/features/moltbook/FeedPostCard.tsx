import { MessageSquare } from "lucide-react";

import { type MoltbookPost } from "../../../hooks/useMoltbook";
import { formatTime, getMoltbookUrl } from "../../../utils/moltbookUtils";
import { Card } from "../../ui/Card";

/** Describes feed post card props. */
interface FeedPostCardProps {
    post: MoltbookPost;
}

/** Renders the feed post card UI. */
export function FeedPostCard({ post }: FeedPostCardProps) {
    return (
        <Card className="p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="bg-primary-900/60 flex w-fit min-w-[2.5rem] items-center justify-center rounded-full px-3 py-1 sm:bg-transparent sm:px-0 sm:py-0">
                    <span className="text-primary-300 text-sm font-medium">
                        {post.upvotes - post.downvotes}
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-primary-500 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <a
                            href={getMoltbookUrl("/m/" + post.submolt_name)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium break-all text-indigo-400 hover:text-indigo-300"
                        >
                            m/{post.submolt_name}
                        </a>
                        <span>•</span>
                        <a
                            href={getMoltbookUrl("/u/" + post.author.name)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-400 hover:text-primary-300 break-all"
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
                        <h3 className="text-primary-100 line-clamp-3 text-base font-medium break-words transition group-hover:text-indigo-300 sm:line-clamp-2">
                            {post.title}
                        </h3>
                        <p className="text-primary-400 group-hover:text-primary-300 mt-1 line-clamp-3 text-sm break-words transition sm:line-clamp-2">
                            {post.content_preview || post.content}
                        </p>
                    </a>
                    <div className="text-primary-500 mt-3 flex flex-wrap items-center gap-4 text-xs">
                        <a
                            href={getMoltbookUrl("/post/" + post.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-primary-200 flex items-center gap-1 transition"
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
