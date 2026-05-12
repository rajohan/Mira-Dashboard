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

function getRoleVariant(role: string) {
    switch (role.toLowerCase()) {
        case "user":
            return "info" as const;
        case "assistant":
            return "success" as const;
        case "system":
            return "warning" as const;
        case "tool":
        case "tool_result":
        case "toolresult":
            return "hook" as const;
        default:
            return "default" as const;
    }
}

export function LiveFeedRow({ item }: LiveFeedRowProps) {
    return (
        <div className="border-primary-700 bg-primary-800 text-primary-100 w-full rounded-2xl border px-3 py-2 text-sm shadow-sm">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="text-primary-300 min-w-0 truncate">
                    {item.sessionLabel}
                </span>
                <span className="text-primary-500 shrink-0">
                    {formatOsloTime(new Date(item.timestamp))}
                </span>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={getRoleVariant(item.role)}>{item.role}</Badge>
                <Badge variant={getSessionTypeVariant(item.sessionType)}>
                    {item.sessionType || "unknown"}
                </Badge>
            </div>
            <p className="text-primary-100 text-sm leading-relaxed break-words whitespace-pre-wrap">
                {item.content}
            </p>
        </div>
    );
}
