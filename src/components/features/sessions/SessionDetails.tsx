import { MessageSquare, RefreshCw, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { Session } from "../../../hooks/useOpenClaw";
import { useSessionHistory } from "../../../hooks/useSessions";
import { formatSessionType } from "../../../utils/sessionUtils";
import { Badge, getSessionTypeVariant } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { MessageBubble } from "./MessageBubble";
import { SessionActionsDropdown } from "./SessionActionsDropdown";
import { SessionStatsBar } from "./SessionStatsBar";

interface SessionDetailsProps {
    session: Session | null;
    onClose: () => void;
    onDelete: () => void;
    onStop: () => void;
    onCompact: () => void;
    onReset: () => void;
}

export function SessionDetails({
    session,
    onClose,
    onDelete,
    onStop,
    onCompact,
    onReset,
}: SessionDetailsProps) {
    const [offset, setOffset] = useState(0);
    const [allMessages, setAllMessages] = useState<
        Array<{ role: string; content: string; timestamp?: string }>
    >([]);
    const limit = 50;
    const { data, isLoading, error, refetch } = useSessionHistory(
        session?.key || null,
        offset,
        limit
    );

    // Accumulate messages when new data arrives
    useEffect(() => {
        if (data?.messages) {
            if (offset === 0) {
                setAllMessages(data.messages);
            } else {
                setAllMessages((prev) => {
                    const existingIds = new Set(prev.map((m) => m.timestamp + m.role));
                    const newMsgs = data.messages.filter(
                        (m) => !existingIds.has(m.timestamp + m.role)
                    );
                    if (newMsgs.length === 0) {
                        return prev;
                    }
                    // Append older messages at the end
                    return [...prev, ...newMsgs];
                });
            }
        }
    }, [data, offset]);

    // Reset when session changes
    useEffect(() => {
        if (session) {
            setOffset(0);
            setAllMessages([]);
        }
    }, [session?.key]);

    const hasMore = data?.hasMore ?? false;

    if (!session) return null;

    const displayName =
        session.displayLabel || session.label || session.displayName || session.id;

    return (
        <Modal isOpen={!!session} onClose={onClose} size="3xl">
            <div className="flex flex-col" style={{ maxHeight: "85vh" }}>
                {/* Header */}
                <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-700 pb-4">
                    <div className="flex min-w-0 items-center gap-3">
                        <Badge variant={getSessionTypeVariant(session.type)}>
                            {formatSessionType(session)}
                        </Badge>
                        <h2 className="truncate text-lg font-semibold text-slate-100">
                            {displayName}
                        </h2>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                        <SessionActionsDropdown
                            onStop={onStop}
                            onCompact={onCompact}
                            onReset={onReset}
                            onDelete={onDelete}
                        />
                        <Button variant="ghost" size="sm" onClick={onClose}>
                            <X className="h-4 w-4" />
                        </Button>
                    </div>
                </div>

                <SessionStatsBar
                    model={session.model || "Unknown"}
                    tokenCount={session.tokenCount || 0}
                    maxTokens={session.maxTokens || 200_000}
                    updatedAt={session.updatedAt}
                />

                {/* Message History */}
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                    <div className="flex flex-shrink-0 items-center justify-between border-b border-slate-700 py-3">
                        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-300">
                            <MessageSquare className="h-4 w-4" /> Message History
                        </h3>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => refetch()}
                            disabled={isLoading}
                        >
                            <RefreshCw
                                className={"h-4 w-4 " + (isLoading ? "animate-spin" : "")}
                            />
                        </Button>
                    </div>
                    <div className="flex-1 overflow-auto py-4">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
                                <span className="ml-2 text-slate-400">
                                    Loading history...
                                </span>
                            </div>
                        ) : error ? (
                            <div className="py-8 text-center">
                                <p className="text-slate-400">{error.message}</p>
                            </div>
                        ) : allMessages.length === 0 ? (
                            <div className="py-8 text-center">
                                <MessageSquare className="mx-auto mb-2 h-8 w-8 text-slate-500" />
                                <p className="text-slate-400">
                                    No message history available
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {allMessages.map((msg, i) => (
                                    <MessageBubble
                                        key={`${msg.timestamp}-${i}`}
                                        role={msg.role}
                                        content={msg.content}
                                        timestamp={msg.timestamp}
                                    />
                                ))}
                                {hasMore && (
                                    <div className="text-center">
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => setOffset((c) => c + limit)}
                                        >
                                            Load more
                                        </Button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </Modal>
    );
}
