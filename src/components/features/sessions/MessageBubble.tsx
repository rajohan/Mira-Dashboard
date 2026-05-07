import { formatDate } from "../../../utils/format";

interface MessageBubbleProps {
    role: string;
    content: string;
    timestamp?: string;
}

export function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
    return (
        <div className="w-full rounded-2xl border border-primary-700 bg-primary-800 px-3 py-2 text-sm text-primary-100 shadow-sm">
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide opacity-70">
                <span className="min-w-0 truncate">{role}</span>
                {timestamp ? (
                    <span className="shrink-0 text-right">{formatDate(timestamp)}</span>
                ) : null}
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {content}
            </p>
        </div>
    );
}
