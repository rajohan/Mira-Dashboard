import type { Virtualizer } from "@tanstack/react-virtual";
import {
    CircleCheck,
    FileText,
    Image as ImageIcon,
    Loader2,
    Paperclip,
    Square,
    Trash2,
    Volume2,
} from "lucide-react";
import {
    type KeyboardEvent,
    lazy,
    type PointerEvent,
    type RefObject,
    Suspense,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from "react";

import type { TextToSpeechRequest } from "../../../../../contracts/tts";
import { apiErrorFromResponse } from "../../../lib/apiError";
import { messageFromError } from "../../../lib/errorMessage";
import { loadLazyModule } from "../../../lib/lazyImportRecovery";
import { formatDate, formatSize } from "../../../utils/format";
import { EmptyState } from "../../ui/EmptyState";
import { ChatMessageDetails } from "./ChatMessageDetails";
import type {
    ChatAttachmentDisplay,
    ChatPreviewItem,
    ChatRow,
    ChatVisibilitySettings,
} from "./chatTypes";
import {
    chatImageDownloadUrl,
    chatImageMimeType,
    chatImageUrl,
    TOOL_ROLE_VARIANTS,
} from "./chatTypes";
import { previewFromAttachment } from "./chatUtilities";

const ChatMarkdown = lazy(async () => {
    const module = await loadLazyModule("chat-markdown", () => import("./ChatMarkdown"));
    return { default: module.ChatMarkdown };
});

function SettledChatMarkdown({ onLoad, text }: { onLoad: () => void; text: string }) {
    const onLoadRef = useRef(onLoad);

    useLayoutEffect(() => {
        onLoadRef.current = onLoad;
    }, [onLoad]);

    useLayoutEffect(() => {
        onLoadRef.current();
    }, [text]);

    return <ChatMarkdown text={text} />;
}

const SCROLL_KEYS = new Set([
    " ",
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
]);

function isScrollbarPointer(event: PointerEvent<HTMLDivElement>): boolean {
    const container = event.currentTarget;
    const scrollbarWidth = container.offsetWidth - container.clientWidth;
    return (
        scrollbarWidth > 0 &&
        event.target === container &&
        event.clientX >= container.getBoundingClientRect().right - scrollbarWidth
    );
}

function isKeyboardScroll(event: KeyboardEvent<HTMLDivElement>): boolean {
    return (
        SCROLL_KEYS.has(event.key) &&
        (event.target === event.currentTarget || event.key !== " ")
    );
}

/** Provides props for chat messages list. */
interface ChatMessagesListProperties {
    isLoadingHistory: boolean;
    isAtBottom: boolean;
    chatRows: ChatRow[];
    messagesContainerRef: RefObject<HTMLDivElement | undefined>;
    messagesVirtualizer: Virtualizer<HTMLDivElement, Element>;
    onDynamicContentLoad: () => void;
    onFollow: () => void;
    onPreview: (isPreview: ChatPreviewItem) => void;
    visibility: ChatVisibilitySettings;
    onScroll: () => void;
    onUserScrollIntent: () => void;
    onTtsError: (error: string) => void;
    onDeleteMessage: (messageKey: string, deleteKeys?: readonly string[]) => void;
    shouldExpandToolDetails?: boolean;
    toolDetailExpansionOverrides?: ReadonlyMap<string, boolean>;
    onToggleToolDetails?: (toolKey: string) => void;
}

/**
 * Renders the attachment icon UI.
 * @returns Rendered the attachment icon UI.
 */
export function AttachmentIcon({ attachment }: { attachment: ChatAttachmentDisplay }) {
    if (attachment.kind === "image") {
        return <ImageIcon className="size-4" />;
    }

    if (attachment.kind === "text") {
        return <FileText className="size-4" />;
    }

    return <Paperclip className="size-4" />;
}

/**
 * Renders the attachment list UI.
 * @returns Rendered the attachment list UI.
 */
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

/**
 * Renders the delete message button UI.
 * @returns Rendered the delete message button UI.
 */
function DeleteMessageButton({
    deleteKeys,
    messageKey,
    onDelete,
}: {
    deleteKeys?: readonly string[];
    messageKey: string;
    onDelete: (messageKey: string, deleteKeys?: readonly string[]) => void;
}) {
    return (
        <button
            type="button"
            onClick={() => onDelete(messageKey, deleteKeys)}
            className="rounded p-1 text-white/80 opacity-75 transition hover:bg-white/20 hover:text-white hover:opacity-100"
            title="Delete message from this chat view"
            aria-label="Delete your message"
        >
            <Trash2 className="size-3.5" />
        </button>
    );
}

/**
 * Renders the tts button UI.
 * @returns Rendered the tts button UI.
 */
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
    onSpeak: (messageKey: string, text: string) => Promise<void> | void;
}) {
    if (!text.trim()) {
        return;
    }

    const isLoading = loadingMessageKey === messageKey;
    const isPlaying = playingMessageKey === messageKey;
    let icon = <Volume2 className="size-3.5" />;
    if (isPlaying) {
        icon = <Square className="size-3.5" />;
    }
    if (isLoading) {
        icon = <Loader2 className="size-3.5 animate-spin" />;
    }

    return (
        <button
            type="button"
            onClick={() => {
                void onSpeak(messageKey, text);
            }}
            disabled={isLoading}
            className="rounded p-1 text-primary-300 opacity-75 transition hover:bg-primary-700 hover:text-primary-100 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={isPlaying ? "Stop reading aloud" : "Read aloud"}
            aria-label={isPlaying ? "Stop reading aloud" : "Read assistant message aloud"}
        >
            {icon}
        </button>
    );
}

/**
 * Renders the typing indicator UI.
 * @returns Rendered the typing indicator UI.
 */
function ActivityIndicator({
    active = true,
    text = "Thinking",
}: {
    active?: boolean;
    text?: string;
}) {
    return (
        <div className="flex max-w-full min-w-0 justify-start pb-3">
            <div className="max-w-full min-w-0 rounded-2xl border border-primary-700 bg-primary-800 px-3 py-2 text-sm text-primary-100 shadow-sm">
                <div className="mb-0.5 text-[11px] tracking-wide uppercase opacity-70">
                    assistant
                </div>
                <div className="flex min-w-0 items-center gap-2 text-primary-300">
                    <span className="min-w-0 flex-1 wrap-break-word">
                        {text || "Thinking"}
                    </span>
                    {active ? (
                        <span
                            className="flex shrink-0 gap-1"
                            aria-label="Assistant is working"
                        >
                            <span className="size-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.24s]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-primary-300 [animation-delay:-0.12s]" />
                            <span className="size-1.5 animate-bounce rounded-full bg-primary-300" />
                        </span>
                    ) : (
                        <CircleCheck
                            className="size-4 shrink-0 text-emerald-400"
                            aria-label="Operation complete"
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

/** Stops active TTS playback and releases the object URL. */
function stopAudioPlayback(
    audioRef: RefObject<HTMLAudioElement | undefined>,
    audioUrlRef: RefObject<string | undefined>,
    setPlayingMessageKey: (messageKey: string | undefined) => void
) {
    audioRef.current?.pause();
    audioRef.current = undefined;

    if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = undefined;
    }

    setPlayingMessageKey(undefined);
}

/**
 * Renders the chat messages list UI.
 * @returns Rendered the chat messages list UI.
 */
export function ChatMessagesList({
    isLoadingHistory,
    isAtBottom,
    chatRows,
    messagesContainerRef,
    messagesVirtualizer,
    onDynamicContentLoad,
    onFollow,
    onPreview,
    visibility,
    onScroll,
    onUserScrollIntent,
    onTtsError,
    onDeleteMessage,
    shouldExpandToolDetails = false,
    toolDetailExpansionOverrides = new Map(),
    onToggleToolDetails,
}: ChatMessagesListProperties) {
    const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
    const audioUrlRef = useRef<string | undefined>(undefined);
    const speakRequestRef = useRef(0);
    const ttsAbortControllerRef = useRef<AbortController | undefined>(undefined);
    const [playingMessageKey, setPlayingMessageKey] = useState<string | undefined>();
    const [loadingMessageKey, setLoadingMessageKey] = useState<string | undefined>();

    const stopAudio = () =>
        stopAudioPlayback(audioRef, audioUrlRef, setPlayingMessageKey);

    useEffect(
        () => () => {
            ttsAbortControllerRef.current?.abort();
            ttsAbortControllerRef.current = undefined;
            stopAudioPlayback(audioRef, audioUrlRef, setPlayingMessageKey);
        },
        []
    );

    /**
     * Speaks or stops the selected chat message.
     * @param messageKey Message key value.
     * @param text Text value.
     */
    const speakMessage = async (messageKey: string, text: string) => {
        if (playingMessageKey === messageKey) {
            speakRequestRef.current += 1;
            stopAudio();
            return;
        }

        speakRequestRef.current += 1;
        const requestToken = speakRequestRef.current;
        const isLatestRequest = () => speakRequestRef.current === requestToken;

        stopAudio();
        ttsAbortControllerRef.current?.abort();
        const abortController = new AbortController();
        ttsAbortControllerRef.current = abortController;
        setLoadingMessageKey(messageKey);
        onTtsError("");

        try {
            const response = await fetch("/api/tts/speak", {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                signal: abortController.signal,
                body: JSON.stringify({ text } satisfies TextToSpeechRequest),
            });

            if (!response.ok) {
                throw await apiErrorFromResponse(response, "Failed to generate speech");
            }

            const audioBlob = await response.blob();
            if (!isLatestRequest()) {
                return;
            }

            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audioRef.current = audio;
            audioUrlRef.current = audioUrl;
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
            onTtsError(messageFromError(error_, "Failed to read message aloud"));
        } finally {
            if (isLatestRequest()) {
                setLoadingMessageKey(undefined);
                if (ttsAbortControllerRef.current === abortController) {
                    ttsAbortControllerRef.current = undefined;
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
                messagesContainerRef.current = element ?? undefined;
            }}
            onKeyDownCapture={(event) => {
                if (isKeyboardScroll(event)) {
                    onUserScrollIntent();
                }
            }}
            onPointerDownCapture={(event) => {
                if (isScrollbarPointer(event)) {
                    onUserScrollIntent();
                }
            }}
            onScroll={onScroll}
            onTouchMoveCapture={onUserScrollIntent}
            onWheelCapture={onUserScrollIntent}
            className="mt-3 min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-0 sm:mt-4 sm:pr-1"
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
            ) : undefined}
            {!isLoadingHistory && chatRows.length === 0 ? (
                <EmptyState message="No chat history yet. Send the first message to this session." />
            ) : undefined}
            {chatRows.length > 0 ? (
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

                        if (row.kind === "typing" || row.kind === "status") {
                            return (
                                <div
                                    key={virtualItem.key}
                                    data-chat-row-key={row.key}
                                    data-index={virtualItem.index}
                                    ref={messagesVirtualizer.measureElement}
                                    className="w-full pb-3"
                                >
                                    <ActivityIndicator
                                        active={row.kind === "typing"}
                                        text={row.message.text}
                                    />
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
                            !isToolResult && row.message.text
                        );
                        const hasPrimaryMessageContent = Boolean(
                            shouldRenderPrimaryText ||
                            row.message.images?.length ||
                            row.message.attachments?.length
                        );

                        return (
                            <div
                                key={virtualItem.key}
                                data-chat-intent={row.message.intent}
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
                                                        deleteKeys={row.deleteKeys}
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
                                                        const imageDownloadUrl =
                                                            chatImageDownloadUrl(image);
                                                        if (!imageDownloadUrl) {
                                                            return;
                                                        }

                                                        const imageUrl =
                                                            chatImageUrl(image);
                                                        const imageMime =
                                                            chatImageMimeType(image);
                                                        const imagePreviewLabel = `Open chat image ${imageIndex + 1} preview`;

                                                        return (
                                                            <button
                                                                key={`${row.key}-image-${imageDownloadUrl}`}
                                                                type="button"
                                                                onClick={() =>
                                                                    onPreview({
                                                                        title: "Chat image",
                                                                        mimeType:
                                                                            imageMime,
                                                                        kind: "image",
                                                                        url: imageDownloadUrl,
                                                                    })
                                                                }
                                                                className="rounded-lg text-left hover:opacity-90 focus:ring-2 focus:ring-accent-400 focus:outline-none"
                                                                title="Open image preview"
                                                                aria-label={
                                                                    imagePreviewLabel
                                                                }
                                                            >
                                                                {imageUrl ? (
                                                                    <img
                                                                        src={imageUrl}
                                                                        alt="Chat attachment"
                                                                        onLoad={
                                                                            onDynamicContentLoad
                                                                        }
                                                                        onError={
                                                                            onDynamicContentLoad
                                                                        }
                                                                        className="max-h-48 max-w-full rounded-lg border border-primary-700 object-contain sm:max-h-56"
                                                                    />
                                                                ) : (
                                                                    <span className="flex items-center gap-1.5 rounded-lg border border-primary-700 px-2.5 py-2 text-xs text-accent-300 underline hover:bg-primary-700/50">
                                                                        <ImageIcon className="size-4" />
                                                                        Open image
                                                                        {` ${imageIndex + 1}`}
                                                                    </span>
                                                                )}
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
                                                                onError={
                                                                    onDynamicContentLoad
                                                                }
                                                                className="max-h-48 max-w-full rounded-lg border border-primary-700 object-contain sm:max-h-56"
                                                            />
                                                        </button>
                                                    ))}
                                            </div>
                                        ) : undefined}
                                        {shouldRenderPrimaryText ? (
                                            <Suspense
                                                fallback={
                                                    <div className="whitespace-pre-wrap">
                                                        {row.message.text}
                                                    </div>
                                                }
                                            >
                                                <SettledChatMarkdown
                                                    onLoad={onDynamicContentLoad}
                                                    text={row.message.text}
                                                />
                                            </Suspense>
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
                                                messageKey={row.key}
                                                onDynamicContentLoad={
                                                    onDynamicContentLoad
                                                }
                                                onToggleToolDetails={onToggleToolDetails}
                                                shouldExpandToolDetails={
                                                    shouldExpandToolDetails
                                                }
                                                toolDetailExpansionOverrides={
                                                    toolDetailExpansionOverrides
                                                }
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
                                            messageKey={row.key}
                                            onDynamicContentLoad={onDynamicContentLoad}
                                            onToggleToolDetails={onToggleToolDetails}
                                            shouldExpandToolDetails={
                                                shouldExpandToolDetails
                                            }
                                            toolDetailExpansionOverrides={
                                                toolDetailExpansionOverrides
                                            }
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
                </div>
            ) : undefined}
        </div>
    );
}
