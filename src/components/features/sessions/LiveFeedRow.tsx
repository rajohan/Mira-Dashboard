import { cn } from "../../../utils/cn";
import { formatOsloTime } from "../../../utils/format";
import { Badge, getSessionTypeVariant } from "../../ui/Badge";

interface LiveFeedRowProps {
    item: {
        id: string;
        sessionLabel: string;
        sessionType: string;
        role: string;
        content: string;
        timestamp: number;
    };
}

export function LiveFeedRow({ item }: LiveFeedRowProps) {
    const normalizedRole = item.role.toLowerCase();
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
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide opacity-70">
                    <span className="min-w-0 truncate">{item.role}</span>
                    <span className="shrink-0 text-right">
                        {formatOsloTime(new Date(item.timestamp))}
                    </span>
                </div>
                <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate text-xs opacity-80">
                        {item.sessionLabel}
                    </span>
                    <Badge variant={getSessionTypeVariant(item.sessionType)}>
                        {item.sessionType || "unknown"}
                    </Badge>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {item.content}
                </p>
            </div>
        </div>
    );
}
