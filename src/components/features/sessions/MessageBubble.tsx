import { formatDate } from "../../../utils/format";

/** Provides props for message bubble. */
interface MessageBubbleProps {
    role: string;
    content: string;
    timestamp?: string;
}

/** Renders the message bubble UI. */
export function MessageBubble({ role, content, timestamp }: MessageBubbleProps) {
    return (
        <div className="border-primary-700 bg-primary-800 text-primary-100 w-full rounded-2xl border px-3 py-2 text-sm shadow-sm">
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] tracking-wide uppercase opacity-70">
                <span className="min-w-0 truncate">{role}</span>
                {timestamp ? (
                    <span className="shrink-0 text-right">{formatDate(timestamp)}</span>
                ) : null}
            </div>
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
                {content}
            </p>
        </div>
    );
}
