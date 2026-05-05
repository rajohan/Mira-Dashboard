import type { Virtualizer } from "@tanstack/react-virtual";
import { FileText, Image as ImageIcon, Loader2, Paperclip } from "lucide-react";
import type { RefObject } from "react";

import { formatDate, formatSize } from "../../../utils/format";
import { EmptyState } from "../../ui/EmptyState";
import { ChatMessageDetails } from "./ChatMessageDetails";
import type {
    ChatAttachmentDisplay,
    ChatPreviewItem,
    ChatRow,
    ChatVisibilitySettings,
} from "./chatTypes";

interface ChatMessagesListProps {
    isLoadingHistory: boolean;
    isAtBottom: boolean;
    chatRows: ChatRow[];
    messagesContainerReference: RefObject<HTMLDivElement | null>;
    messagesVirtualizer: Virtualizer<HTMLDivElement, Element>;
    onDynamicContentLoad: () => void;
    onFollow: () => void;
    onPreview: (preview: ChatPreviewItem) => void;
    visibility: ChatVisibilitySettings;
    onScroll: () => void;
}

function AttachmentIcon({ attachment }: { attachment: ChatAttachmentDisplay }) {
    if (attachment.kind === "image") {
        return <ImageIcon className="h-4 w-4" />;
    }

    if (attachment.kind === "text") {
        return <FileText className="h-4 w-4" />;
    }

    return <Paperclip className="h-4 w-4" />;
}

function base64ToText(base64: string): string {
    const binary = window.atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder().decode(bytes);
}

function previewFromAttachment(
    attachment: ChatAttachmentDisplay
): ChatPreviewItem | null {
    if (!attachment.dataUrl && !attachment.contentBase64) {
        return null;
    }

    const mimeType = attachment.mimeType || "application/octet-stream";
    const url =
        attachment.dataUrl ||
        (attachment.contentBase64
            ? `data:${mimeType};base64,${attachment.contentBase64}`
            : undefined);

    return {
        title: attachment.fileName,
        mimeType,
        kind: attachment.kind,
        url,
        text:
            attachment.kind === "text" && attachment.contentBase64
                ? base64ToText(attachment.contentBase64)
                : undefined,
        sizeBytes: attachment.sizeBytes,
    };
}

function AttachmentList({
    attachments,
    onPreview,
}: {
    attachments: ChatAttachmentDisplay[];
    onPreview: (preview: ChatPreviewItem) => void;
}) {
    if (attachments.length === 0) {
        return null;
    }

    return (
        <div className="mt-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => {
                const preview = previewFromAttachment(attachment);
                const content = (
                    <>
                        <AttachmentIcon attachment={attachment} />
                        <span className="truncate">{attachment.fileName}</span>
                        {attachment.sizeBytes ? (
                            <span className="shrink-0 text-primary-400">
                                {formatSize(attachment.sizeBytes)}
                            </span>
                        ) : null}
                    </>
                );

                if (!preview) {
                    return (
                        <div
                            key={attachment.id}
                            className="flex max-w-full items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-xs text-primary-100"
                            title={attachment.mimeType}
                        >
                            {content}
                        </div>
                    );
                }

                return (
                    <button
                        key={attachment.id}
                        type="button"
                        onClick={() => onPreview(preview)}
                        className="flex max-w-full items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-800"
                        title={attachment.mimeType}
                    >
                        {content}
                    </button>
                );
            })}
        </div>
    );
}

function TypingIndicator() {
    return (
        <div className="flex justify-start pb-3">
            <div className="rounded-2xl border border-primary-700 bg-primary-800 px-4 py-3 text-sm text-primary-100 shadow-sm">
                <div className="mb-1 text-[11px] uppercase tracking-wide opacity-70">
                    assistant
                </div>
                <div className="flex items-center gap-2 text-primary-300">
                    <span>Typing</span>
                    <span className="flex gap-1" aria-label="Assistant is typing">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.24s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.12s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary-300" />
                    </span>
                </div>
            </div>
        </div>
    );
}

export function ChatMessagesList({
    isLoadingHistory,
    isAtBottom,
    chatRows,
    messagesContainerReference,
    messagesVirtualizer,
    onDynamicContentLoad,
    onFollow,
    onPreview,
    visibility,
    onScroll,
}: ChatMessagesListProps) {
    const virtualItems = messagesVirtualizer.getVirtualItems();
    const firstVirtualItem = virtualItems[0];
    const lastVirtualItem = virtualItems.at(-1);
    const paddingTop = firstVirtualItem?.start ?? 0;
    const paddingBottom = lastVirtualItem
        ? Math.max(messagesVirtualizer.getTotalSize() - lastVirtualItem.end, 0)
        : 0;

    return (
        <div
            ref={messagesContainerReference}
            onScroll={onScroll}
            className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
            style={{ overflowAnchor: "none" }}
        >
            {!isAtBottom && chatRows.length > 0 ? (
                <button
                    type="button"
                    onClick={onFollow}
                    className="sticky top-2 z-10 float-right mb-2 mr-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600"
                >
                    ↓ Follow
                </button>
            ) : null}

            {isLoadingHistory ? (
                <div className="flex items-center justify-center py-10 text-primary-400">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading chat…
                </div>
            ) : chatRows.length === 0 ? (
                <EmptyState message="No chat history yet. Send the first message to this session." />
            ) : (
                <div className="w-full">
                    {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : null}
                    {virtualItems.map((virtualItem) => {
                        const row = chatRows[virtualItem.index];

                        if (!row) {
                            return null;
                        }

                        if (row.kind === "typing") {
                            return (
                                <div
                                    key={virtualItem.key}
                                    data-index={virtualItem.index}
                                    ref={messagesVirtualizer.measureElement}
                                    className="w-full pb-3"
                                >
                                    <TypingIndicator />
                                </div>
                            );
                        }

                        const normalizedRole = row.message.role.toLowerCase();
                        const isUser = normalizedRole === "user";
                        const isToolResult =
                            normalizedRole === "tool" ||
                            normalizedRole === "toolresult" ||
                            normalizedRole === "tool_result";
                        const shouldRenderPrimaryText = Boolean(
                            row.message.text && !(visibility.showTools && isToolResult)
                        );

                        return (
                            <div
                                key={virtualItem.key}
                                data-index={virtualItem.index}
                                ref={messagesVirtualizer.measureElement}
                                className="w-full pb-3"
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
                                        {row.message.images &&
                                        row.message.images.length > 0 ? (
                                            <div className="mb-2 flex flex-wrap gap-2">
                                                {row.message.images.map(
                                                    (image, imageIndex) => {
                                                        const imageData =
                                                            image.source?.data ||
                                                            image.data;
                                                        const imageMime =
                                                            image.source?.media_type ||
                                                            image.mimeType ||
                                                            "image/png";

                                                        if (!imageData) {
                                                            return null;
                                                        }

                                                        const imageUrl = `data:${imageMime};base64,${imageData}`;

                                                        return (
                                                            <button
                                                                key={`${row.key}-image-${imageIndex}`}
                                                                type="button"
                                                                onClick={() =>
                                                                    onPreview({
                                                                        title: "Chat image",
                                                                        mimeType:
                                                                            imageMime,
                                                                        kind: "image",
                                                                        url: imageUrl,
                                                                    })
                                                                }
                                                                className="rounded-lg text-left hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent-400"
                                                                title="Open image preview"
                                                            >
                                                                <img
                                                                    src={imageUrl}
                                                                    alt="Chat attachment"
                                                                    onLoad={
                                                                        onDynamicContentLoad
                                                                    }
                                                                    className="max-h-56 max-w-full rounded-lg border border-primary-700 object-contain"
                                                                />
                                                            </button>
                                                        );
                                                    }
                                                )}
                                            </div>
                                        ) : null}
                                        {row.message.attachments?.some(
                                            (attachment) =>
                                                attachment.kind === "image" &&
                                                attachment.dataUrl
                                        ) ? (
                                            <div className="mb-2 flex flex-wrap gap-2">
                                                {row.message.attachments
                                                    .filter(
                                                        (attachment) =>
                                                            attachment.kind === "image" &&
                                                            attachment.dataUrl
                                                    )
                                                    .map((attachment) => (
                                                        <button
                                                            key={`${row.key}-${attachment.id}`}
                                                            type="button"
                                                            onClick={() => {
                                                                const preview =
                                                                    previewFromAttachment(
                                                                        attachment
                                                                    );
                                                                if (preview) {
                                                                    onPreview(preview);
                                                                }
                                                            }}
                                                            className="rounded-lg text-left hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-accent-400"
                                                            title={`Open ${attachment.fileName}`}
                                                        >
                                                            <img
                                                                src={attachment.dataUrl}
                                                                alt={attachment.fileName}
                                                                onLoad={
                                                                    onDynamicContentLoad
                                                                }
                                                                className="max-h-56 max-w-full rounded-lg border border-primary-700 object-contain"
                                                            />
                                                        </button>
                                                    ))}
                                            </div>
                                        ) : null}
                                        {shouldRenderPrimaryText ? (
                                            <div className="whitespace-pre-wrap break-words">
                                                {row.message.text}
                                            </div>
                                        ) : null}
                                        <AttachmentList
                                            attachments={
                                                row.message.attachments?.filter(
                                                    (attachment) =>
                                                        attachment.kind !== "image" ||
                                                        !attachment.dataUrl
                                                ) || []
                                            }
                                            onPreview={onPreview}
                                        />
                                        <ChatMessageDetails
                                            message={row.message}
                                            visibility={visibility}
                                        />
                                        {row.message.timestamp ? (
                                            <div className="mt-2 text-[11px] opacity-60">
                                                {formatDate(row.message.timestamp)}
                                            </div>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {paddingBottom > 0 ? <div style={{ height: paddingBottom }} /> : null}
                </div>
            )}
        </div>
    );
}
