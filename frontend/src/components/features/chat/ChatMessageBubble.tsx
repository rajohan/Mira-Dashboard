import { Image as ImageIcon } from "lucide-react";
import { lazy, Suspense, useLayoutEffect, useRef } from "react";

import { loadLazyModule } from "../../../lib/lazyImportRecovery";
import { formatDate } from "../../../utils/format";
import { previewFromAttachment } from "./chatAttachmentUtilities";
import { AttachmentList } from "./ChatMessageAttachments";
import { DeleteMessageButton, TtsButton } from "./ChatMessageControls";
import { ChatMessageDetails } from "./ChatMessageDetails";
import type { ChatPreviewItem, ChatRow, ChatVisibilitySettings } from "./chatTypes";
import {
    chatImageDownloadUrl,
    chatImageMimeType,
    chatImageUrl,
    TOOL_ROLE_VARIANTS,
} from "./chatTypes";
import type { ChatTextToSpeechController } from "./useChatTextToSpeech";

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

interface ChatMessageBubbleProperties {
    onDeleteMessage: (messageKey: string, deleteKeys?: readonly string[]) => void;
    onDynamicContentLoad: () => void;
    onPreview: (preview: ChatPreviewItem) => void;
    onToggleToolDetails?: (toolKey: string) => void;
    row: ChatRow;
    shouldExpandToolDetails: boolean;
    toolDetailExpansionOverrides: ReadonlyMap<string, boolean>;
    tts: ChatTextToSpeechController;
    visibility: ChatVisibilitySettings;
}

export function ChatMessageBubble({
    onDeleteMessage,
    onDynamicContentLoad,
    onPreview,
    onToggleToolDetails,
    row,
    shouldExpandToolDetails,
    toolDetailExpansionOverrides,
    tts,
    visibility,
}: ChatMessageBubbleProperties) {
    const normalizedRole = row.message.role.toLowerCase();
    const isUser = normalizedRole === "user";
    const canDeleteMessage = isUser && row.kind === "message";
    const canSpeakMessage =
        !isUser &&
        normalizedRole === "assistant" &&
        row.kind === "message" &&
        Boolean(row.message.text);
    const isToolResult = TOOL_ROLE_VARIANTS.includes(normalizedRole);
    const shouldRenderPrimaryText = Boolean(!isToolResult && row.message.text);
    const hasPrimaryMessageContent = Boolean(
        shouldRenderPrimaryText ||
        row.message.images?.length ||
        row.message.attachments?.length
    );

    return (
        <>
            <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
                <div
                    className={[
                        "max-w-[94%] min-w-0 rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[86%] lg:max-w-[80%]",
                        isUser
                            ? "bg-accent-500 text-white"
                            : "border border-primary-700 bg-primary-800 text-primary-100",
                    ].join(" ")}
                >
                    <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] tracking-wide uppercase opacity-70">
                        <span className="min-w-0 truncate">{row.message.role}</span>
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
                                    loadingMessageKey={tts.loadingMessageKey}
                                    messageKey={row.key}
                                    onSpeak={tts.speakMessage}
                                    playingMessageKey={tts.playingMessageKey}
                                    text={row.message.text}
                                />
                            ) : undefined}
                        </div>
                    </div>
                    {row.message.images?.length ? (
                        <div className="mb-1.5 flex flex-wrap gap-1.5">
                            {row.message.images.map((image, imageIndex) => {
                                const imageDownloadUrl = chatImageDownloadUrl(image);
                                if (!imageDownloadUrl) return;
                                const imageUrl = chatImageUrl(image);
                                const imageMime = chatImageMimeType(image);
                                return (
                                    <button
                                        key={`${row.key}-image-${imageDownloadUrl}`}
                                        aria-label={`Open chat image ${imageIndex + 1} preview`}
                                        className="rounded-lg text-left hover:opacity-90 focus:ring-2 focus:ring-accent-400 focus:outline-none"
                                        onClick={() =>
                                            onPreview({
                                                title: "Chat image",
                                                mimeType: imageMime,
                                                kind: "image",
                                                url: imageDownloadUrl,
                                            })
                                        }
                                        title="Open image preview"
                                        type="button"
                                    >
                                        {imageUrl ? (
                                            <img
                                                alt="Chat attachment"
                                                className="max-h-48 max-w-full rounded-lg border border-primary-700 object-contain sm:max-h-56"
                                                onError={onDynamicContentLoad}
                                                onLoad={onDynamicContentLoad}
                                                src={imageUrl}
                                            />
                                        ) : (
                                            <span className="flex items-center gap-1.5 rounded-lg border border-primary-700 px-2.5 py-2 text-xs text-accent-300 underline hover:bg-primary-700/50">
                                                <ImageIcon className="size-4" />
                                                Open image {imageIndex + 1}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    ) : undefined}
                    {row.message.attachments?.some(
                        (attachment) => attachment.kind === "image" && attachment.dataUrl
                    ) ? (
                        <div className="mb-1.5 flex flex-wrap gap-1.5">
                            {row.message.attachments
                                .filter(
                                    (attachment) =>
                                        attachment.kind === "image" && attachment.dataUrl
                                )
                                .map((attachment) => (
                                    <button
                                        key={`${row.key}-${attachment.id}`}
                                        aria-label={`Open ${attachment.fileName} preview`}
                                        className="rounded-lg text-left hover:opacity-90 focus:ring-2 focus:ring-accent-400 focus:outline-none"
                                        onClick={() =>
                                            onPreview(previewFromAttachment(attachment)!)
                                        }
                                        title={`Open ${attachment.fileName}`}
                                        type="button"
                                    >
                                        <img
                                            alt={attachment.fileName}
                                            className="max-h-48 max-w-full rounded-lg border border-primary-700 object-contain sm:max-h-56"
                                            onError={onDynamicContentLoad}
                                            onLoad={onDynamicContentLoad}
                                            src={attachment.dataUrl}
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
                                    attachment.kind !== "image" || !attachment.dataUrl
                            ) || []
                        }
                        onPreview={onPreview}
                    />
                    {hasPrimaryMessageContent ? undefined : (
                        <ChatMessageDetails
                            message={row.message}
                            messageKey={row.key}
                            onDynamicContentLoad={onDynamicContentLoad}
                            onToggleToolDetails={onToggleToolDetails}
                            shouldExpandToolDetails={shouldExpandToolDetails}
                            toolDetailExpansionOverrides={toolDetailExpansionOverrides}
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
                        shouldExpandToolDetails={shouldExpandToolDetails}
                        toolDetailExpansionOverrides={toolDetailExpansionOverrides}
                        visibility={visibility}
                    />
                </div>
            ) : undefined}
        </>
    );
}
