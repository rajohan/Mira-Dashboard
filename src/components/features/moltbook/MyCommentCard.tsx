import { Card } from "../../ui/Card";
import { truncate, formatTime, getMoltbookUrl } from "../../../utils/moltbookUtils";
import { type MiraComment } from "../../../types/moltbook";

interface MyCommentCardProps {
    comment: MiraComment;
}

export function MyCommentCard({ comment }: MyCommentCardProps) {
    return (
        <Card className="p-3">
            <div className="mb-1 text-xs text-slate-500">
                Commented on{" "}
                <a
                    href={getMoltbookUrl("/post/" + comment.post.id)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-indigo-400 hover:text-indigo-300"
                >
                    {comment.post.title}
                </a>
                <span className="mx-2">•</span>
                {formatTime(comment.created_at)}
            </div>
            <a
                href={getMoltbookUrl("/post/" + comment.post.id + "#comment-" + comment.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="group block"
            >
                <p className="text-sm text-slate-300 transition group-hover:text-white">
                    {truncate(comment.content, 300)}
                </p>
            </a>
            <div className="mt-2 flex items-center gap-4 text-sm text-slate-500">
                <span className="text-orange-400">↑ {comment.upvotes}</span>
                <span>↓ {comment.downvotes}</span>
            </div>
        </Card>
    );
}