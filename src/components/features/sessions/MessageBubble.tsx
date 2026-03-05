import { formatDate } from "../../../utils/format";

interface MessageBubbleProps {
    role: string;
    content: string;
    timestamp?: string;
}

export function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
    const isUser = role === "user";

    return (
        <div
            className={
                "rounded-lg p-3 " +
                (isUser
                    ? "border border-blue-500/20 bg-blue-500/10"
                    : "border border-primary-600/50 bg-primary-700/50")
            }
        >
            <div className="mb-1 flex items-center justify-between">
                <span
                    className={
                        "text-xs font-medium uppercase " +
                        (isUser ? "text-blue-400" : "text-green-400")
                    }
                >
                    {role}
                </span>
                {timestamp && (
                    <span className="text-xs text-primary-500">
                        {formatDate(timestamp)}
                    </span>
                )}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-primary-200">
                {content?.slice(0, 500)}
                {content?.length > 500 && "..."}
            </p>
        </div>
    );
}
