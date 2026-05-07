import { Mic, Paperclip, Send, Smile, Square, X } from "lucide-react";
import { type RefObject, useEffect, useRef, useState } from "react";

import { formatSize } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Textarea } from "../../ui/Textarea";
import type { ChatPreviewItem, ChatSendAttachment } from "./chatTypes";
import { base64ToText } from "./chatUtils";
import type { SlashCommandSuggestion } from "./slashCommands";

const CHAT_EMOJIS = [
    "😀",
    "😄",
    "😂",
    "😊",
    "😍",
    "🥳",
    "😎",
    "🤔",
    "😅",
    "😭",
    "👍",
    "👎",
    "🙏",
    "🙌",
    "👏",
    "💪",
    "🔥",
    "✨",
    "💡",
    "✅",
    "❌",
    "⚠️",
    "❤️",
    "🚀",
];

interface ChatComposerProps {
    attachments: ChatSendAttachment[];
    canSend: boolean;
    draft: string;
    fileInputReference: RefObject<HTMLInputElement | null>;
    isConnected: boolean;
    isRecording: boolean;
    isSending: boolean;
    isTranscribing: boolean;
    selectedSessionKey: string;
    slashCommandSuggestions: SlashCommandSuggestion[];
    onApplySlashSuggestion: (value: string) => void;
    onAttachFiles: (files: FileList | null) => void;
    onChangeDraft: (value: string) => void;
    onPreview: (preview: ChatPreviewItem) => void;
    onRemoveAttachment: (attachmentId: string) => void;
    onSend: () => void;
    onToggleRecording: () => void;
}

export function ChatComposer({
    attachments,
    canSend,
    draft,
    fileInputReference,
    isConnected,
    isRecording,
    isSending,
    isTranscribing,
    selectedSessionKey,
    slashCommandSuggestions,
    onApplySlashSuggestion,
    onAttachFiles,
    onChangeDraft,
    onPreview,
    onRemoveAttachment,
    onSend,
    onToggleRecording,
}: ChatComposerProps) {
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const composerReference = useRef<HTMLDivElement | null>(null);
    const textareaReference = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (!showEmojiPicker) {
            return;
        }

        const handlePointerDown = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                composerReference.current?.contains(event.target)
            ) {
                return;
            }

            setShowEmojiPicker(false);
        };

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setShowEmojiPicker(false);
            }
        };

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [showEmojiPicker]);

    const insertEmoji = (emoji: string) => {
        const textarea = textareaReference.current;
        const selectionStart = textarea?.selectionStart ?? draft.length;
        const selectionEnd = textarea?.selectionEnd ?? draft.length;
        const nextDraft = `${draft.slice(0, selectionStart)}${emoji}${draft.slice(
            selectionEnd
        )}`;
        const nextCursor = selectionStart + emoji.length;

        onChangeDraft(nextDraft);
        setShowEmojiPicker(false);

        window.setTimeout(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextCursor, nextCursor);
        }, 0);
    };

    return (
        <div
            ref={composerReference}
            className="mt-3 border-t border-primary-700 pt-3 sm:mt-4 sm:pt-4"
        >
            {attachments.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                    {attachments.map((attachment) => (
                        <button
                            key={attachment.id}
                            type="button"
                            onClick={() =>
                                onPreview({
                                    title: attachment.fileName,
                                    mimeType: attachment.mimeType,
                                    kind: attachment.kind,
                                    url:
                                        attachment.dataUrl ||
                                        `data:${attachment.mimeType};base64,${attachment.contentBase64}`,
                                    text:
                                        attachment.kind === "text"
                                            ? base64ToText(attachment.contentBase64)
                                            : undefined,
                                    sizeBytes: attachment.sizeBytes,
                                })
                            }
                            className="group flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-primary-700 bg-primary-800 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-700"
                        >
                            {attachment.kind === "image" && attachment.dataUrl ? (
                                <img
                                    src={attachment.dataUrl}
                                    alt=""
                                    className="h-8 w-8 shrink-0 rounded object-cover"
                                />
                            ) : (
                                <Paperclip className="h-4 w-4 text-primary-400" />
                            )}
                            <div className="min-w-0 flex-1">
                                <div className="truncate">{attachment.fileName}</div>
                                <div className="text-primary-400">
                                    {formatSize(attachment.sizeBytes)}
                                </div>
                            </div>
                            <span
                                role="button"
                                tabIndex={0}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onRemoveAttachment(attachment.id);
                                }}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        onRemoveAttachment(attachment.id);
                                    }
                                }}
                                className="rounded p-1 text-primary-400 hover:bg-primary-700 hover:text-primary-100"
                                aria-label={`Remove ${attachment.fileName}`}
                            >
                                <X className="h-3.5 w-3.5" />
                            </span>
                        </button>
                    ))}
                </div>
            ) : null}

            <div className="flex flex-col gap-2 sm:gap-3 md:flex-row">
                <input
                    ref={fileInputReference}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => onAttachFiles(event.target.files)}
                />
                <div className="relative min-w-0 flex-1">
                    {slashCommandSuggestions.length > 0 ? (
                        <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-primary-700 bg-primary-900 shadow-2xl">
                            <div className="border-b border-primary-700 px-3 py-2 text-xs font-medium uppercase tracking-wide text-primary-400">
                                Slash commands
                            </div>
                            <div className="max-h-72 overflow-y-auto py-1">
                                {slashCommandSuggestions.map((suggestion) => (
                                    <button
                                        key={suggestion.value}
                                        type="button"
                                        onClick={() =>
                                            onApplySlashSuggestion(suggestion.value)
                                        }
                                        className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-primary-800 focus:bg-primary-800 focus:outline-none"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-sm text-primary-100">
                                                {suggestion.title}
                                            </span>
                                            <span className="mt-0.5 block truncate text-xs text-primary-400">
                                                {suggestion.description}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    <Textarea
                        ref={textareaReference}
                        value={draft}
                        onChange={(event) => onChangeDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (
                                event.key === "Tab" &&
                                slashCommandSuggestions.length > 0
                            ) {
                                event.preventDefault();
                                onApplySlashSuggestion(
                                    slashCommandSuggestions[0]?.value || draft
                                );
                                return;
                            }

                            if (
                                event.key === "Enter" &&
                                !event.shiftKey &&
                                !event.nativeEvent.isComposing
                            ) {
                                event.preventDefault();
                                onSend();
                            }
                        }}
                        disabled={!selectedSessionKey || !isConnected || isSending}
                        placeholder={
                            selectedSessionKey
                                ? "Message, attach files, or use / commands (try /help)"
                                : "Choose a session first"
                        }
                        rows={4}
                        className="min-h-24 resize-y sm:min-h-32"
                    />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:flex md:flex-col">
                    <div className="relative">
                        {showEmojiPicker ? (
                            <div className="absolute bottom-full right-0 z-20 mb-2 grid w-64 grid-cols-6 gap-1 rounded-xl border border-primary-700 bg-primary-900 p-2 shadow-2xl sm:w-72">
                                {CHAT_EMOJIS.map((emoji) => (
                                    <button
                                        key={emoji}
                                        type="button"
                                        onClick={() => insertEmoji(emoji)}
                                        className="rounded-lg p-2 text-xl hover:bg-primary-800 focus:bg-primary-800 focus:outline-none"
                                        aria-label={`Insert ${emoji}`}
                                    >
                                        {emoji}
                                    </button>
                                ))}
                            </div>
                        ) : null}
                        <Button
                            variant="secondary"
                            size="md"
                            onClick={() => setShowEmojiPicker((previous) => !previous)}
                            disabled={!isConnected || !selectedSessionKey || isSending}
                            title="Insert emoji"
                            className="w-full px-2 sm:px-4"
                        >
                            <Smile className="mr-1 h-4 w-4 sm:mr-2" /> Emoji
                        </Button>
                    </div>
                    <Button
                        variant={isRecording ? "primary" : "secondary"}
                        size="md"
                        onClick={onToggleRecording}
                        disabled={
                            !isConnected ||
                            !selectedSessionKey ||
                            isSending ||
                            isTranscribing
                        }
                        title={isRecording ? "Stop recording" : "Record voice input"}
                        className="w-full px-2 sm:px-4"
                    >
                        {isRecording ? (
                            <Square className="mr-1 h-4 w-4 sm:mr-2" />
                        ) : (
                            <Mic className="mr-1 h-4 w-4 sm:mr-2" />
                        )}
                        {isRecording ? "Stop" : isTranscribing ? "STT…" : "Voice"}
                    </Button>
                    <Button
                        variant="secondary"
                        size="md"
                        onClick={() => fileInputReference.current?.click()}
                        disabled={
                            !isConnected ||
                            !selectedSessionKey ||
                            isSending ||
                            isRecording ||
                            attachments.length >= 10
                        }
                        title="Attach files"
                        className="w-full px-2 sm:px-4"
                    >
                        <Paperclip className="mr-1 h-4 w-4 sm:mr-2" /> Attach
                    </Button>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={onSend}
                        disabled={!canSend || isRecording || isTranscribing}
                        className="w-full px-2 sm:px-4"
                    >
                        <Send className="mr-1 h-4 w-4 sm:mr-2" /> Send
                    </Button>
                </div>
            </div>
        </div>
    );
}
