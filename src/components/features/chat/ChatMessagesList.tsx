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
import { type RefObject, useEffect, useRef, useState } from "react";

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
import { TOOL_ROLE_VARIANTS } from "./chatTypes";
import { chatErrorMessage } from "./chatUtilities";

/** Provides props for chat messages list. */
interface ChatMessagesListProperties {
    isLoadingHistory: boolean;
    isAtBottom: boolean;
    chatRows: ChatRow[];
    messagesBottomReference: RefObject<HTMLDivElement | undefined>;
    messagesContainerReference: RefObject<HTMLDivElement | undefined>;
    messagesVirtualizer: Virtualizer<HTMLDivElement, Element>;
    onDynamicContentLoad: () => void;
    onFollow: () => void;
    onPreview: (isPreview: ChatPreviewItem) => void;
    visibility: ChatVisibilitySettings;
    onScroll: () => void;
    onTtsError: (error: string) => void;
    onDeleteMessage: (messageKey: string) => void;
}

/** Renders the attachment icon UI. */
export function AttachmentIcon({ attachment }: { attachment: ChatAttachmentDisplay }) {
    if (attachment.kind === "image") {
        return <ImageIcon className="size-4" />;
    }

    if (attachment.kind === "text") {
        return <FileText className="size-4" />;
    }

    return <Paperclip className="size-4" />;
}

/** Decodes base64 text attachments without throwing during rendering. */
export function base64ToText(base64: string): string | undefined {
    try {
        const bytes = Uint8Array.fromBase64(base64);
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    } catch {
        return undefined;
    }
}

/** Builds preview data from an attachment. */
export function previewFromAttachment(
    attachment: ChatAttachmentDisplay
): ChatPreviewItem | undefined {
    if (!attachment.dataUrl && !attachment.contentBase64) {
        return undefined;
    }

    const mimeType = attachment.mimeType || "application/octet-stream";
    const url =
        attachment.dataUrl || `data:${mimeType};base64,${attachment.contentBase64!}`;

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

/** Renders the attachment list UI. */
function AttachmentList({
    attachments,
    onPreview,
}: {
    attachments: ChatAttachmentDisplay[];
    onPreview: (preview: ChatPreviewItem) => void;
}) {
    if (attachments.length === 0) {
        return;
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
                        ) : undefined}
                    </>
                );

                if (!preview) {
                    return (
                        <div
                            key={attachment.id}
                            className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-xs text-primary-100"
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
                        className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-800"
                        title={attachment.mimeType}
                    >
                        {content}
                    </button>
                );
            })}
        </div>
    );
}

/** Renders the delete message button UI. */
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
            <Trash2 className="size-3.5" />
        </button>
    );
}

/** Renders the tts button UI. */
function TtsButton({
    text,
    messageKey,
    playingMessageKey,
    loadingMessageKey,
    onSpeak,
}: {
    text: string;
    messageKey: string;
    playingMessageKey: string | undefined;
    loadingMessageKey: string | undefined;
    onSpeak: (messageKey: string, text: string) => void;
}) {
    if (!text.trim()) {
        return;
    }

    const isLoading = loadingMessageKey === messageKey;
    const isPlaying = playingMessageKey === messageKey;

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
                <Loader2 className="size-3.5 animate-spin" />
            ) : isPlaying ? (
                <Square className="size-3.5" />
            ) : (
                <Volume2 className="size-3.5" />
            )}
        </button>
    );
}

/** Renders the typing indicator UI. */
function TypingIndicator({ text = "Thinking" }: { text?: string }) {
    return (
        <div className="flex justify-start pb-3">
            <div className="rounded-2xl border border-primary-700 bg-primary-800 px-3 py-2 text-sm text-primary-100 shadow-sm">
                <div className="mb-0.5 text-[11px] tracking-wide uppercase opacity-70">
                    assistant
                </div>
                <div className="flex items-center gap-2 text-primary-300">
                    <span className="min-w-0 wrap-break-word">{text || "Thinking"}</span>
                    <span
                        className="flex shrink-0 gap-1"
                        aria-label="Assistant is working"
                    >
                        <span className="size-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.24s]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.12s]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-primary-300" />
                    </span>
                </div>
            </div>
        </div>
    );
}

/** Stops active TTS playback and releases the object URL. */
function stopAudioPlayback(
    audioReference: RefObject<HTMLAudioElement | undefined>,
    audioUrlReference: RefObject<string | undefined>,
    setPlayingMessageKey: (messageKey: string | undefined) => void
) {
    audioReference.current?.pause();
    audioReference.current = undefined;

    if (audioUrlReference.current) {
        URL.revokeObjectURL(audioUrlReference.current);
        audioUrlReference.current = undefined;
    }

    setPlayingMessageKey(undefined);
}

/** Renders the chat messages list UI. */
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
}: ChatMessagesListProperties) {
    const audioReference = useRef<HTMLAudioElement | undefined>(undefined);
    const audioUrlReference = useRef<string | undefined>(undefined);
    const speakRequestReference = useRef(0);
    const ttsAbortControllerReference = useRef<AbortController | undefined>(undefined);
    const [playingMessageKey, setPlayingMessageKey] = useState<string | undefined>(
        undefined
    );
    const [loadingMessageKey, setLoadingMessageKey] = useState<string | undefined>(
        undefined
    );

    const stopAudio = () =>
        stopAudioPlayback(audioReference, audioUrlReference, setPlayingMessageKey);

    useEffect(
        () => () => {
            ttsAbortControllerReference.current?.abort();
            ttsAbortControllerReference.current = undefined;
            stopAudioPlayback(audioReference, audioUrlReference, setPlayingMessageKey);
        },
        []
    );

    /** Speaks or stops the selected chat message. */
    const speakMessage = async (messageKey: string, text: string) => {
        if (playingMessageKey === messageKey) {
            speakRequestReference.current += 1;
            stopAudio();
            return;
        }

        speakRequestReference.current += 1;
        const requestToken = speakRequestReference.current;
        const isLatestRequest = () => speakRequestReference.current === requestToken;

        stopAudio();
        ttsAbortControllerReference.current?.abort();
        const abortController = new AbortController();
        ttsAbortControllerReference.current = abortController;
        setLoadingMessageKey(messageKey);
        onTtsError("");

        try {
            const response = await fetch("/api/tts/speak", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                signal: abortController.signal,
                body: JSON.stringify({ text }),
            });

            if (!response.ok) {
                let error: { error?: string };
                try {
                    error = (await response.json()) as { error?: string };
                } catch {
                    error = { error: "Failed to generate speech" };
                }
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            const audioBlob = await response.blob();
            if (!isLatestRequest()) {
                return;
            }

            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audioReference.current = audio;
            audioUrlReference.current = audioUrl;
            audio.addEventListener(
                "ended",
                () => {
                    if (isLatestRequest()) {
                        stopAudio();
                    }
                },
                { once: true }
            );
            audio.addEventListener(
                "error",
                () => {
                    if (!isLatestRequest()) {
                        return;
                    }
                    onTtsError("Failed to play generated speech.");
                    stopAudio();
                },
                { once: true }
            );
            setPlayingMessageKey(messageKey);
            await audio.play();
        } catch (error_) {
            if (!isLatestRequest()) {
                return;
            }
            stopAudio();
            onTtsError(chatErrorMessage(error_, "Failed to read message aloud"));
        } finally {
            if (isLatestRequest()) {
                setLoadingMessageKey(undefined);
                if (ttsAbortControllerReference.current === abortController) {
                    ttsAbortControllerReference.current = undefined;
                }
            }
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
            ref={(element) => {
                messagesContainerReference.current = element ?? undefined;
            }}
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
            ) : undefined}

            {isLoadingHistory && chatRows.length === 0 ? (
                <div className="flex items-center justify-center gap-1.5 py-10 text-primary-400">
                    <Loader2 className="size-4 animate-spin" />
                    Loading chat…
                </div>
            ) : chatRows.length === 0 ? (
                <EmptyState message="No chat history yet. Send the first message to this session." />
            ) : (
                <div className="w-full">
                    {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : undefined}
                    {virtualItems.map((virtualItem) => {
                        const row = chatRows[virtualItem.index];

                        if (!row) {
                            return (
                                <div
                                    key={virtualItem.key}
                                    data-index={virtualItem.index}
                                    ref={messagesVirtualizer.measureElement}
                                    className="h-0 overflow-hidden"
                                    aria-hidden="true"
                                />
                            );
                        }

                        if (row.kind === "typing") {
                            return (
                                <div
                                    key={virtualItem.key}
                                    data-chat-row-key={row.key}
                                    data-index={virtualItem.index}
                                    ref={messagesVirtualizer.measureElement}
                                    className="w-full pb-3"
                                >
                                    <TypingIndicator text={row.message.text} />
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
                            Boolean(row.message.text);
                        const isToolResult = TOOL_ROLE_VARIANTS.includes(normalizedRole);
                        const shouldRenderPrimaryText = Boolean(
                            row.message.text && !isToolResult
                        );
                        const hasPrimaryMessageContent = Boolean(
                            shouldRenderPrimaryText ||
                            row.message.images?.length ||
                            row.message.attachments?.length
                        );

                        return (
                            <div
                                key={virtualItem.key}
                                data-chat-row-key={row.key}
                                data-index={virtualItem.index}
                                ref={messagesVirtualizer.measureElement}
                                className="w-full pb-3"
                            >
                                <div
                                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                                >
                                    <div
                                        className={[
                                            "max-w-[94%] min-w-0 rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[86%] lg:max-w-[80%]",
                                            isUser
                                                ? "bg-accent-500 text-white"
                                                : "border border-primary-700 bg-primary-800 text-primary-100",
                                        ].join(" ")}
                                    >
                                        <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] tracking-wide uppercase opacity-70">
                                            <span className="min-w-0 truncate">
                                                {row.message.role}
                                            </span>
                                            <div className="flex shrink-0 items-center gap-1">
                                                {canDeleteMessage ? (
                                                    <DeleteMessageButton
                                                        messageKey={row.key}
                                                        onDelete={onDeleteMessage}
                                                    />
                                                ) : undefined}
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
                                                ) : undefined}
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
                                                        if (!imageData) {
                                                            return;
                                                        }

                                                        const imageMime =
                                                            image.source?.media_type ||
                                                            image.mimeType ||
                                                            "image/png";

                                                        const imageUrl = `data:${imageMime};base64,${imageData}`;
                                                        const imagePreviewLabel = `Open chat image ${imageIndex + 1} preview`;

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
                                                                className="rounded-lg text-left hover:opacity-90 focus:ring-2 focus:ring-accent-400 focus:outline-none"
                                                                title="Open image preview"
                                                                aria-label={
                                                                    imagePreviewLabel
                                                                }
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
                                        ) : undefined}
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
                                                                onPreview(
                                                                    previewFromAttachment(
                                                                        attachment
                                                                    )!
                                                                );
                                                            }}
                                                            className="rounded-lg text-left hover:opacity-90 focus:ring-2 focus:ring-accent-400 focus:outline-none"
                                                            title={`Open ${attachment.fileName}`}
                                                            aria-label={`Open ${attachment.fileName} preview`}
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
                                        ) : undefined}
                                        {shouldRenderPrimaryText ? (
                                            <ChatMarkdown text={row.message.text} />
                                        ) : undefined}
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
                                        {hasPrimaryMessageContent ? undefined : (
                                            <ChatMessageDetails
                                                message={row.message}
                                                visibility={visibility}
                                            />
                                        )}
                                        {row.message.timestamp ? (
                                            <div className="mt-1.5 text-[11px] opacity-60">
                                                {formatDate(row.message.timestamp)}
                                            </div>
                                        ) : undefined}
                                    </div>
                                </div>
                                {!isUser && hasPrimaryMessageContent ? (
                                    <div className="max-w-[94%] min-w-0 sm:max-w-[86%] lg:max-w-[80%]">
                                        <ChatMessageDetails
                                            message={row.message}
                                            visibility={visibility}
                                        />
                                    </div>
                                ) : undefined}
                            </div>
                        );
                    })}
                    {paddingBottom > 0 ? (
                        <div style={{ height: paddingBottom }} />
                    ) : undefined}
                    <div
                        ref={(element) => {
                            messagesBottomReference.current = element ?? undefined;
                        }}
                        aria-hidden="true"
                    />
                </div>
            )}
        </div>
    );
}
