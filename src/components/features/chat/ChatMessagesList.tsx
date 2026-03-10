import { Loader2 } from "lucide-react";
import type { RefObject } from "react";
import type { Virtualizer } from "@tanstack/react-virtual";

import { EmptyState } from "../../ui/EmptyState";
import { formatDate } from "../../../utils/format";
import type { ChatRow } from "./chatTypes";

interface ChatMessagesListProps {
    isLoadingHistory: boolean;
    chatRows: ChatRow[];
    messagesContainerReference: RefObject<HTMLDivElement | null>;
    onScroll: () => void;
    messagesVirtualizer: Virtualizer<HTMLDivElement, Element>;
}

export function ChatMessagesList({
    isLoadingHistory,
    chatRows,
    messagesContainerReference,
    onScroll,
    messagesVirtualizer,
}: ChatMessagesListProps) {
    return (
        <div
            ref={messagesContainerReference}
            onScroll={onScroll}
            className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
        >
            {isLoadingHistory ? (
                <div className="flex items-center justify-center py-10 text-primary-400">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading chat…
                </div>
            ) : chatRows.length === 0 ? (
                <EmptyState message="No chat history yet. Send the first message to this session." />
            ) : (
                <div
                    className="relative w-full"
                    style={{
                        height: `${messagesVirtualizer.getTotalSize()}px`,
                    }}
                >
                    {messagesVirtualizer.getVirtualItems().map((virtualItem) => {
                        const row = chatRows[virtualItem.index];

                        if (!row) {
                            return null;
                        }

                        const isUser = row.message.role.toLowerCase() === "user";

                        return (
                            <div
                                key={row.key}
                                className="absolute left-0 top-0 w-full"
                                style={{
                                    transform: `translateY(${virtualItem.start}px)`,
                                }}
                            >
                                <div
                                    ref={messagesVirtualizer.measureElement}
                                    data-index={virtualItem.index}
                                    className="pb-3"
                                >
                                    <div
                                        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                                    >
                                        <div
                                            className={[
                                                "max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm",
                                                isUser
                                                    ? "bg-accent-500 text-white"
                                                    : "border border-primary-700 bg-primary-800 text-primary-100",
                                            ].join(" ")}
                                        >
                                            <div className="mb-1 text-[11px] uppercase tracking-wide opacity-70">
                                                {row.message.role}
                                            </div>
                                            {row.message.images && row.message.images.length > 0 ? (
                                                <div className="mb-2 flex flex-wrap gap-2">
                                                    {row.message.images.map((image, imageIndex) => {
                                                        const imageData =
                                                            image.source?.data || image.data;
                                                        const imageMime =
                                                            image.source?.media_type ||
                                                            image.mimeType ||
                                                            "image/png";

                                                        if (!imageData) {
                                                            return null;
                                                        }

                                                        return (
                                                            <img
                                                                key={`${row.key}-image-${imageIndex}`}
                                                                src={`data:${imageMime};base64,${imageData}`}
                                                                alt="Chat attachment"
                                                                className="max-h-56 max-w-full rounded-lg border border-primary-700 object-contain"
                                                            />
                                                        );
                                                    })}
                                                </div>
                                            ) : null}
                                            <div className="whitespace-pre-wrap break-words">
                                                {row.message.text ||
                                                    (row.message.images && row.message.images.length > 0
                                                        ? null
                                                        : "[no text content]")}
                                            </div>
                                            {row.message.timestamp ? (
                                                <div className="mt-2 text-[11px] opacity-60">
                                                    {formatDate(row.message.timestamp)}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
