import { MessageSquare } from "lucide-react";

import { type MiraPost } from "../../../types/moltbook";
import { formatTime, getMoltbookUrl } from "../../../utils/moltbookUtils";
import { Card } from "../../ui/Card";

/** Describes my post card props. */
interface MyPostCardProps {
    post: MiraPost;
}

/** Renders the my post card UI. */
export function MyPostCard({ post }: MyPostCardProps) {
    return (
        <Card className="p-3 sm:p-4">
            <div className="text-primary-500 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <a
                    href={getMoltbookUrl("/m/" + post.submolt.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-indigo-400 hover:text-indigo-300"
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
                <h3 className="text-primary-100 line-clamp-3 text-base font-medium break-words transition group-hover:text-indigo-300 sm:line-clamp-2">
                    {post.title}
                </h3>
                <p className="text-primary-400 group-hover:text-primary-300 mt-1 line-clamp-3 text-sm break-words transition sm:line-clamp-2">
                    {post.content_preview}
                </p>
            </a>
            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                <span className="text-orange-400">↑ {post.upvotes}</span>
                <span className="text-primary-500">↓ {post.downvotes}</span>
                <a
                    href={getMoltbookUrl("/post/" + post.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-400 hover:text-primary-200 flex items-center gap-1"
                >
                    <MessageSquare className="h-3 w-3" />
                    {post.comment_count}
                </a>
            </div>
        </Card>
    );
}
