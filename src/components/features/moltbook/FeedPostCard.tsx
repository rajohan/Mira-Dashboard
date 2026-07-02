import { MessageSquare } from "lucide-react";

import { type MoltbookPost } from "../../../hooks/useMoltbook";
import { formatTime, getMoltbookUrl } from "../../../utils/moltbookUtilities";
import { Card } from "../../ui/Card";

/** Provides props for feed post card. */
interface FeedPostCardProperties {
    post: MoltbookPost;
}

/** Renders the feed post card UI. */
export function FeedPostCard({ post }: FeedPostCardProperties) {
    return (
        <Card className="p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex w-fit min-w-10 items-center justify-center rounded-full bg-primary-900/60 px-3 py-1 sm:bg-transparent sm:p-0">
                    <span className="text-sm font-medium text-primary-300">
                        {post.upvotes - post.downvotes}
                    </span>
                </div>
                <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-primary-500">
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
                            className="break-all text-primary-400 hover:text-primary-300"
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
                        <h3 className="line-clamp-3 text-base font-medium wrap-break-word text-primary-100 transition group-hover:text-indigo-300 sm:line-clamp-2">
                            {post.title}
                        </h3>
                        <p className="mt-1 line-clamp-3 text-sm wrap-break-word text-primary-400 transition group-hover:text-primary-300 sm:line-clamp-2">
                            {post.content_preview || post.content}
                        </p>
                    </a>
                    <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-primary-500">
                        <a
                            href={getMoltbookUrl("/post/" + post.id)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 transition hover:text-primary-200"
                        >
                            <MessageSquare className="size-3" />
                            {post.comment_count} comments
                        </a>
                    </div>
                </div>
            </div>
        </Card>
    );
}
