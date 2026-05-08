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
            className="border-primary-700 mt-3 border-t pt-3 sm:mt-4 sm:pt-4"
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
                            className="group border-primary-700 bg-primary-800 text-primary-100 hover:border-primary-500 hover:bg-primary-700 flex max-w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1 text-left text-xs"
                        >
                            {attachment.kind === "image" && attachment.dataUrl ? (
                                <img
                                    src={attachment.dataUrl}
                                    alt=""
                                    className="h-8 w-8 shrink-0 rounded object-cover"
                                />
                            ) : (
                                <Paperclip className="text-primary-400 h-4 w-4" />
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
                                className="text-primary-400 hover:bg-primary-700 hover:text-primary-100 rounded p-1"
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
                        <div className="border-primary-700 bg-primary-900 absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border shadow-2xl">
                            <div className="border-primary-700 text-primary-400 border-b px-3 py-2 text-xs font-medium tracking-wide uppercase">
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
                                        className="hover:bg-primary-800 focus:bg-primary-800 flex w-full items-start gap-3 px-3 py-2 text-left focus:outline-none"
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="text-primary-100 block truncate font-mono text-sm">
                                                {suggestion.title}
                                            </span>
                                            <span className="text-primary-400 mt-0.5 block truncate text-xs">
                                                {suggestion.description}
                                            </span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {showEmojiPicker ? (
                        <div className="border-primary-700 bg-primary-900 absolute right-0 bottom-full left-0 z-30 mb-2 rounded-xl border p-2 shadow-2xl sm:left-auto sm:w-80">
                            <div className="text-primary-400 mb-2 flex items-center justify-between px-1 text-xs font-medium tracking-wide uppercase">
                                <span>Emoji</span>
                                <button
                                    type="button"
                                    onClick={() => setShowEmojiPicker(false)}
                                    className="text-primary-400 hover:bg-primary-800 hover:text-primary-100 rounded p-1"
                                    aria-label="Close emoji picker"
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            </div>
                            <div className="grid max-h-52 grid-cols-6 gap-1 overflow-y-auto sm:max-h-64">
                                {CHAT_EMOJIS.map((emoji) => (
                                    <button
                                        key={emoji}
                                        type="button"
                                        onClick={() => insertEmoji(emoji)}
                                        className="hover:bg-primary-800 focus:bg-primary-800 rounded-lg p-2.5 text-xl focus:outline-none"
                                        aria-label={`Insert ${emoji}`}
                                    >
                                        {emoji}
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
                        className="min-h-24 resize-y pr-12 text-base sm:min-h-32 sm:text-sm"
                    />
                    <button
                        type="button"
                        onClick={() => setShowEmojiPicker((previous) => !previous)}
                        disabled={!isConnected || !selectedSessionKey || isSending}
                        className="text-primary-400 hover:bg-primary-600 hover:text-primary-100 focus:bg-primary-600 focus:text-primary-100 absolute right-2 bottom-2 rounded-full p-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                        title="Insert emoji"
                        aria-label="Insert emoji"
                    >
                        <Smile className="h-5 w-5" />
                    </button>
                </div>
                <div className="grid grid-cols-3 gap-2 md:flex md:flex-col">
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
