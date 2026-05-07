import { cn } from "../../../utils/cn";
import { formatDate } from "../../../utils/format";

interface MessageBubbleProps {
    role: string;
    content: string;
    timestamp?: string;
}

export function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
    const normalizedRole = role.toLowerCase();
    const isUser = normalizedRole === "user";

    return (
        <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
            <div
                className={cn(
                    "min-w-0 max-w-[94%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[86%] lg:max-w-[80%]",
                    isUser
                        ? "bg-accent-500 text-white"
                        : "border border-primary-700 bg-primary-800 text-primary-100"
                )}
            >
                <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide opacity-70">
                    <span className="min-w-0 truncate">{role}</span>
                    {timestamp ? (
                        <span className="shrink-0 text-right">
                            {formatDate(timestamp)}
                        </span>
                    ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {content}
                </p>
            </div>
        </div>
    );
}
