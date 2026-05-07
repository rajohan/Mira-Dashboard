import type { Virtualizer } from "@tanstack/react-virtual";
import {
    FileText,
    Image as ImageIcon,
    Loader2,
    Paperclip,
    Square,
    Trash2,
    Volume2,
} from "lucide-react";
import { type RefObject, useRef, useState } from "react";

import { formatDate, formatSize } from "../../../utils/format";
import { EmptyState } from "../../ui/EmptyState";
import { ChatMarkdown } from "./ChatMarkdown";
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
    messagesBottomReference: RefObject<HTMLDivElement | null>;
    messagesContainerReference: RefObject<HTMLDivElement | null>;
    messagesVirtualizer: Virtualizer<HTMLDivElement, Element>;
    onDynamicContentLoad: () => void;
    onFollow: () => void;
    onPreview: (preview: ChatPreviewItem) => void;
    visibility: ChatVisibilitySettings;
    onScroll: () => void;
    onTtsError: (error: string) => void;
    onDeleteMessage: (messageKey: string) => void;
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
        <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
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
                            className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-xs text-primary-100"
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
                        className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-800"
                        title={attachment.mimeType}
                    >
                        {content}
                    </button>
                );
            })}
        </div>
    );
}

function DeleteMessageButton({
    messageKey,
    onDelete,
}: {
    messageKey: string;
    onDelete: (messageKey: string) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onDelete(messageKey)}
            className="rounded p-1 text-white/80 opacity-75 transition hover:bg-white/20 hover:text-white hover:opacity-100"
            title="Delete message from this chat view"
            aria-label="Delete your message"
        >
            <Trash2 className="h-3.5 w-3.5" />
        </button>
    );
}

function TtsButton({
    text,
    messageKey,
    playingMessageKey,
    loadingMessageKey,
    onSpeak,
}: {
    text: string;
    messageKey: string;
    playingMessageKey: string | null;
    loadingMessageKey: string | null;
    onSpeak: (messageKey: string, text: string) => void;
}) {
    const isLoading = loadingMessageKey === messageKey;
    const isPlaying = playingMessageKey === messageKey;

    if (!text.trim()) {
        return null;
    }

    return (
        <button
            type="button"
            onClick={() => onSpeak(messageKey, text)}
            disabled={isLoading}
            className="rounded p-1 text-primary-300 opacity-75 transition hover:bg-primary-700 hover:text-primary-100 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={isPlaying ? "Stop reading aloud" : "Read aloud"}
            aria-label={isPlaying ? "Stop reading aloud" : "Read assistant message aloud"}
        >
            {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isPlaying ? (
                <Square className="h-3.5 w-3.5" />
            ) : (
                <Volume2 className="h-3.5 w-3.5" />
            )}
        </button>
    );
}

function TypingIndicator() {
    return (
        <div className="flex justify-start pb-3">
            <div className="rounded-2xl border border-primary-700 bg-primary-800 px-3 py-2 text-sm text-primary-100 shadow-sm">
                <div className="mb-0.5 text-[11px] uppercase tracking-wide opacity-70">
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
    messagesBottomReference,
    messagesContainerReference,
    messagesVirtualizer,
    onDynamicContentLoad,
    onFollow,
    onPreview,
    visibility,
    onScroll,
    onTtsError,
    onDeleteMessage,
}: ChatMessagesListProps) {
    const audioReference = useRef<HTMLAudioElement | null>(null);
    const audioUrlReference = useRef<string | null>(null);
    const [playingMessageKey, setPlayingMessageKey] = useState<string | null>(null);
    const [loadingMessageKey, setLoadingMessageKey] = useState<string | null>(null);

    const stopAudio = () => {
        audioReference.current?.pause();
        audioReference.current = null;

        if (audioUrlReference.current) {
            URL.revokeObjectURL(audioUrlReference.current);
            audioUrlReference.current = null;
        }

        setPlayingMessageKey(null);
    };

    const speakMessage = async (messageKey: string, text: string) => {
        if (playingMessageKey === messageKey) {
            stopAudio();
            return;
        }

        stopAudio();
        setLoadingMessageKey(messageKey);
        onTtsError("");

        try {
            const response = await fetch("/api/tts/speak", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
            });

            if (!response.ok) {
                const error = (await response
                    .json()
                    .catch(() => ({ error: "Failed to generate speech" }))) as {
                    error?: string;
                };
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const audioUrl = URL.createObjectURL(await response.blob());
            const audio = new Audio(audioUrl);
            audioReference.current = audio;
            audioUrlReference.current = audioUrl;
            audio.addEventListener("ended", stopAudio, { once: true });
            audio.addEventListener(
                "error",
                () => {
                    onTtsError("Failed to play generated speech.");
                    stopAudio();
                },
                { once: true }
            );
            setPlayingMessageKey(messageKey);
            await audio.play();
        } catch (error_) {
            stopAudio();
            onTtsError((error_ as Error).message || "Failed to read message aloud");
        } finally {
            setLoadingMessageKey(null);
        }
    };
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
            className="mt-3 min-h-0 flex-1 overflow-y-auto pr-0 sm:mt-4 sm:pr-1"
            style={{ overflowAnchor: "none" }}
        >
            {!isAtBottom && chatRows.length > 0 ? (
                <button
                    type="button"
                    onClick={onFollow}
                    className="sticky top-2 z-10 float-right mb-2 rounded-full bg-accent-500 px-3 py-1 text-xs text-white shadow-lg hover:bg-accent-600 sm:mr-2"
                >
                    ↓ Follow
                </button>
            ) : null}

            {isLoadingHistory && chatRows.length === 0 ? (
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
                        const canDeleteMessage = isUser && row.kind === "message";
                        const canSpeakMessage =
                            !isUser &&
                            normalizedRole === "assistant" &&
                            row.kind === "message" &&
                            Boolean(row.message.text.trim());
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
                                            "min-w-0 max-w-[94%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[86%] lg:max-w-[80%]",
                                            isUser
                                                ? "bg-accent-500 text-white"
                                                : "border border-primary-700 bg-primary-800 text-primary-100",
                                        ].join(" ")}
                                    >
                                        <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide opacity-70">
                                            <span className="min-w-0 truncate">
                                                {row.message.role}
                                            </span>
                                            <div className="flex shrink-0 items-center gap-1">
                                                {canDeleteMessage ? (
                                                    <DeleteMessageButton
                                                        messageKey={row.key}
                                                        onDelete={onDeleteMessage}
                                                    />
                                                ) : null}
                                                {canSpeakMessage ? (
                                                    <TtsButton
                                                        text={row.message.text}
                                                        messageKey={row.key}
                                                        playingMessageKey={
                                                            playingMessageKey
                                                        }
                                                        loadingMessageKey={
                                                            loadingMessageKey
                                                        }
                                                        onSpeak={speakMessage}
                                                    />
                                                ) : null}
                                            </div>
                                        </div>
                                        {row.message.images &&
                                        row.message.images.length > 0 ? (
                                            <div className="mb-1.5 flex flex-wrap gap-1.5">
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
                                                                    className="max-h-48 max-w-full rounded-lg border border-primary-700 object-contain sm:max-h-56"
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
                                            <div className="mb-1.5 flex flex-wrap gap-1.5">
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
                                                                className="max-h-48 max-w-full rounded-lg border border-primary-700 object-contain sm:max-h-56"
                                                            />
                                                        </button>
                                                    ))}
                                            </div>
                                        ) : null}
                                        {shouldRenderPrimaryText ? (
                                            <ChatMarkdown text={row.message.text} />
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
                                            <div className="mt-1.5 text-[11px] opacity-60">
                                                {formatDate(row.message.timestamp)}
                                            </div>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {paddingBottom > 0 ? <div style={{ height: paddingBottom }} /> : null}
                    <div ref={messagesBottomReference} aria-hidden="true" />
                </div>
            )}
        </div>
    );
}
