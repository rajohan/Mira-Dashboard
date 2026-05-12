import { type MiraComment } from "../../../types/moltbook";
import { formatTime, getMoltbookUrl, truncate } from "../../../utils/moltbookUtils";
import { Card } from "../../ui/Card";

/** Describes my comment card props. */
interface MyCommentCardProps {
    comment: MiraComment;
}

/** Renders the my comment card UI. */
export function MyCommentCard({ comment }: MyCommentCardProps) {
    return (
        <Card className="p-3 sm:p-4">
            <div className="text-primary-500 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span>Commented on</span>
                <a
                    href={getMoltbookUrl("/post/" + comment.post.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 break-words text-indigo-400 hover:text-indigo-300"
                >
                    {comment.post.title}
                </a>
                <span>•</span>
                <span>{formatTime(comment.created_at)}</span>
            </div>
            <a
                href={getMoltbookUrl(
                    "/post/" + comment.post.id + "#comment-" + comment.id
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="group block"
            >
                <p className="text-primary-300 text-sm break-words transition group-hover:text-white">
                    {truncate(comment.content, 300)}
                </p>
            </a>
            <div className="text-primary-500 mt-3 flex flex-wrap items-center gap-4 text-sm">
                <span className="text-orange-400">↑ {comment.upvotes}</span>
                <span>↓ {comment.downvotes}</span>
            </div>
        </Card>
    );
}
