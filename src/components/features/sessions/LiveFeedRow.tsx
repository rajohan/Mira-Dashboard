import { formatOsloTime } from "../../../utils/format";
import { Badge } from "../../ui/Badge";

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
    return (
        <div className="w-full rounded-2xl border border-primary-700 bg-primary-800 px-3 py-2 text-sm text-primary-100 shadow-sm">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-primary-300">
                    {item.sessionLabel}
                </span>
                <span className="shrink-0 text-primary-500">
                    {formatOsloTime(new Date(item.timestamp))}
                </span>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge>{item.role}</Badge>
                <Badge>{item.sessionType || "unknown"}</Badge>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-primary-100">
                {item.content}
            </p>
        </div>
    );
}
