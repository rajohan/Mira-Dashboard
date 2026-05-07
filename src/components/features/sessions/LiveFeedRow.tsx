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
        <div className="rounded-lg border border-primary-700 p-3">
            <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-primary-300">
                    {item.sessionLabel}
                </span>
                <span className="shrink-0 text-primary-500">
                    {formatOsloTime(new Date(item.timestamp))}
                </span>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={getRoleVariant(item.role)}>{item.role}</Badge>
                <Badge variant={getSessionTypeVariant(item.sessionType)}>
                    {item.sessionType || "unknown"}
                </Badge>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm text-primary-100">
                {item.content}
            </p>
        </div>
    );
}
