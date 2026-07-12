import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import {
    Brain,
    Mic,
    Minimize2,
    Paperclip,
    Send,
    Settings2,
    Smile,
    Square,
    Wrench,
    X,
} from "lucide-react";
import {
    type KeyboardEvent as ReactKeyboardEvent,
    type RefObject,
    useEffect,
    useRef,
    useState,
} from "react";

import type { Session } from "../../../types/session";
import { formatSize } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { chatSpeedOptions, chatThinkingOptions, selectedChatSpeed } from "./ChatHeader";
import type { ChatPreviewItem, ChatSendAttachment } from "./chatTypes";
import { base64ToText, type ChatModelOption } from "./chatUtilities";
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

/**
 * Returns whether Enter should submit instead of inserting a newline.
 *
 * @param event - Keyboard event from the composer textarea.
 * @returns True when Enter should send the message.
 */
function shouldSendFromEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return false;
    }

    const coarsePointerQuery = globalThis.matchMedia?.("(pointer: coarse)");
    return !coarsePointerQuery?.matches;
}

/** Provides props for chat composer. */
interface ChatComposerProperties {
    attachments: ChatSendAttachment[];
    canSend: boolean;
    draft: string;
    fileInputReference: RefObject<HTMLInputElement | undefined>;
    isConnected: boolean;
    isRecording: boolean;
    isSending: boolean;
    isTranscribing: boolean;
    selectedSessionKey: string;
    selectedSession?: Session;
    modelOptions?: ChatModelOption[];
    shouldShowThinking?: boolean;
    shouldShowTools?: boolean;
    sessionControlsDisabled?: boolean;
    isCompacting?: boolean;
    slashCommandSuggestions: SlashCommandSuggestion[];
    onApplySlashSuggestion: (value: string) => void;
    onAttachFiles: (files: FileList | undefined) => void;
    onChangeDraft: (value: string) => void;
    onPreview: (isPreview: ChatPreviewItem) => void;
    onRemoveAttachment: (attachmentId: string) => void;
    onSend: () => void;
    onToggleRecording: () => void;
    onToggleThinking?: () => void;
    onToggleTools?: () => void;
    onSelectThinkingLevel?: (value: string) => void;
    onSelectSpeed?: (value: string) => void;
    onSelectModel?: (value: string) => void;
    onCompact?: () => void;
}

/** Renders the chat composer UI. */
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
    selectedSession,
    modelOptions = [],
    shouldShowThinking,
    shouldShowTools,
    sessionControlsDisabled,
    isCompacting,
    slashCommandSuggestions,
    onApplySlashSuggestion,
    onAttachFiles,
    onChangeDraft,
    onPreview,
    onRemoveAttachment,
    onSend,
    onToggleRecording,
    onToggleThinking,
    onToggleTools,
    onSelectThinkingLevel,
    onSelectSpeed,
    onSelectModel,
    onCompact,
}: ChatComposerProperties) {
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [slashSuggestionsDismissed, setSlashSuggestionsDismissed] = useState(false);
    const composerReference = useRef<HTMLDivElement | undefined>(undefined);
    const textareaReference = useRef<HTMLTextAreaElement | undefined>(undefined);
    const visibleSlashCommandSuggestions = slashSuggestionsDismissed
        ? []
        : slashCommandSuggestions;
    const modelSelectOptions = modelOptions.map((option) => ({
        value: option.id || option.name || option.label || "",
        label: option.label || option.name || option.id || "Unknown",
    }));
    const currentModel = selectedSession?.model || "";
    if (
        currentModel &&
        modelSelectOptions.every((option) => option.value !== currentModel)
    ) {
        modelSelectOptions.unshift({ value: currentModel, label: currentModel });
    }
    if (modelSelectOptions.length === 0) {
        modelSelectOptions.push({ value: "", label: "Default" });
    }

    useEffect(() => {
        if (!showEmojiPicker) {
            return;
        }

        /** Responds to pointer down events. */
        const handlePointerDown = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                composerReference.current?.contains(event.target)
            ) {
                return;
            }

            setShowEmojiPicker(false);
        };

        /** Responds to key down events. */
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

    useEffect(() => {
        if (slashCommandSuggestions.length === 0 || slashSuggestionsDismissed) {
            return;
        }

        /** Responds to pointer down events. */
        const handlePointerDown = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                composerReference.current?.contains(event.target)
            ) {
                return;
            }

            setSlashSuggestionsDismissed(true);
        };

        /** Responds to key down events. */
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setSlashSuggestionsDismissed(true);
            }
        };

        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [slashCommandSuggestions.length, slashSuggestionsDismissed]);

    /** Performs insert emoji. */
    const insertEmoji = (emoji: string) => {
        const textarea = textareaReference.current;
        if (
            !textarea ||
            typeof textarea.selectionStart !== "number" ||
            typeof textarea.selectionEnd !== "number"
        ) {
            return;
        }

        const selectionStart = textarea.selectionStart;
        const selectionEnd = textarea.selectionEnd;
        const nextDraft = `${draft.slice(0, selectionStart)}${emoji}${draft.slice(
            selectionEnd
        )}`;
        const nextCursor = selectionStart + emoji.length;

        onChangeDraft(nextDraft);
        setShowEmojiPicker(false);

        setTimeout(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextCursor, nextCursor);
        }, 0);
    };

    return (
        <div
            ref={(element) => {
                composerReference.current = element ?? undefined;
            }}
            className="mt-3 border-t border-primary-700 pt-3 sm:mt-4 sm:pt-4"
        >
            {attachments.length > 0 ? (
                <div className="mb-3 flex flex-wrap gap-2">
                    {attachments.map((attachment) => (
                        <div
                            key={attachment.id}
                            className="group flex max-w-full min-w-0 items-center gap-1 rounded-lg border border-primary-700 bg-primary-800 p-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-700"
                        >
                            <button
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
                                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left focus:ring-2 focus:ring-accent-500 focus:outline-none"
                            >
                                {attachment.kind === "image" && attachment.dataUrl ? (
                                    <img
                                        src={attachment.dataUrl}
                                        alt=""
                                        className="size-8 shrink-0 rounded object-cover"
                                    />
                                ) : (
                                    <Paperclip className="size-4 text-primary-400" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="truncate">{attachment.fileName}</div>
                                    <div className="text-primary-400">
                                        {formatSize(attachment.sizeBytes)}
                                    </div>
                                </div>
                            </button>
                            <button
                                type="button"
                                onClick={() => onRemoveAttachment(attachment.id)}
                                className="rounded p-1 text-primary-400 hover:bg-primary-700 hover:text-primary-100 focus:ring-2 focus:ring-accent-500 focus:outline-none"
                                aria-label={`Remove ${attachment.fileName}`}
                            >
                                <X className="size-3.5" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : undefined}

            <div className="flex flex-col gap-2 sm:gap-3 md:flex-row">
                <input
                    ref={(element) => {
                        fileInputReference.current = element ?? undefined;
                    }}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(event) => onAttachFiles(event.target.files ?? undefined)}
                />
                <div className="relative min-w-0 flex-1">
                    {visibleSlashCommandSuggestions.length > 0 ? (
                        <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-primary-700 bg-primary-900 shadow-2xl">
                            <div className="border-b border-primary-700 px-3 py-2 text-xs font-medium tracking-wide text-primary-400 uppercase">
                                Slash commands
                            </div>
                            <div className="max-h-72 overflow-y-auto py-1">
                                {visibleSlashCommandSuggestions.map((suggestion) => (
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
                    ) : undefined}
                    {showEmojiPicker ? (
                        <div className="absolute inset-x-0 bottom-full z-30 mb-2 rounded-xl border border-primary-700 bg-primary-900 p-2 shadow-2xl sm:left-auto sm:w-80">
                            <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium tracking-wide text-primary-400 uppercase">
                                <span>Emoji</span>
                                <button
                                    type="button"
                                    onClick={() => setShowEmojiPicker(false)}
                                    className="rounded p-1 text-primary-400 hover:bg-primary-800 hover:text-primary-100"
                                    aria-label="Close emoji picker"
                                >
                                    <X className="size-4" />
                                </button>
                            </div>
                            <div className="grid max-h-52 grid-cols-6 gap-1 overflow-y-auto sm:max-h-64">
                                {CHAT_EMOJIS.map((emoji) => (
                                    <button
                                        key={emoji}
                                        type="button"
                                        onClick={() => insertEmoji(emoji)}
                                        className="rounded-lg p-2.5 text-xl hover:bg-primary-800 focus:bg-primary-800 focus:outline-none"
                                        aria-label={`Insert ${emoji}`}
                                    >
                                        {emoji}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : undefined}
                    <Textarea
                        ref={(element) => {
                            textareaReference.current = element ?? undefined;
                        }}
                        value={draft}
                        onChange={(event) => {
                            setSlashSuggestionsDismissed(false);
                            onChangeDraft(event.target.value);
                        }}
                        onKeyDown={(event) => {
                            if (
                                event.key === "Tab" &&
                                visibleSlashCommandSuggestions.length > 0
                            ) {
                                event.preventDefault();
                                onApplySlashSuggestion(
                                    visibleSlashCommandSuggestions[0]?.value || draft
                                );
                                return;
                            }

                            if (shouldSendFromEnter(event) && canSend) {
                                event.preventDefault();
                                onSend();
                            }
                        }}
                        enterKeyHint="enter"
                        disabled={!selectedSessionKey || !isConnected}
                        placeholder={
                            selectedSessionKey
                                ? "Message, attach files, or use / commands (try /help)"
                                : "Choose a session first"
                        }
                        rows={4}
                        className="min-h-24 resize-y rounded-b-none border-b-0 text-base sm:min-h-32 sm:text-sm"
                    />
                    <div className="flex min-h-11 items-center justify-between rounded-b-lg border border-t-0 border-primary-600 bg-primary-700 px-2 py-1">
                        <div className="flex items-center gap-1">
                            <Popover className="relative">
                                <PopoverButton
                                    aria-label="Model and response settings"
                                    className="flex items-center rounded p-1.5 text-primary-400 outline-none hover:bg-primary-700 hover:text-primary-100 data-focus:bg-primary-700 data-focus:text-primary-100"
                                >
                                    <Settings2 className="size-4" />
                                </PopoverButton>
                                <PopoverPanel
                                    anchor={{ to: "top start", gap: 8 }}
                                    className="z-50 w-72 space-y-3 rounded-lg border border-primary-600 bg-primary-800 p-3 text-sm shadow-xl outline-none"
                                >
                                    <Select
                                        ariaLabel="Model"
                                        width="w-full"
                                        value={selectedSession?.model || ""}
                                        disabled={sessionControlsDisabled}
                                        onChange={(value) => onSelectModel?.(value)}
                                        options={modelSelectOptions}
                                    />
                                    <Select
                                        ariaLabel="Thinking"
                                        width="w-full"
                                        value={selectedSession?.thinkingLevel || ""}
                                        disabled={sessionControlsDisabled}
                                        onChange={(value) =>
                                            onSelectThinkingLevel?.(value)
                                        }
                                        options={chatThinkingOptions(selectedSession)}
                                    />
                                    <Select
                                        ariaLabel="Speed"
                                        width="w-full"
                                        value={selectedChatSpeed(selectedSession)}
                                        disabled={sessionControlsDisabled}
                                        onChange={(value) => onSelectSpeed?.(value)}
                                        options={chatSpeedOptions(selectedSession)}
                                    />
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        className="w-full justify-center"
                                        disabled={sessionControlsDisabled || isCompacting}
                                        onClick={() => onCompact?.()}
                                    >
                                        <Minimize2 className="size-4" />
                                        {isCompacting ? "Compacting…" : "Compact context"}
                                    </Button>
                                </PopoverPanel>
                            </Popover>
                            <button
                                type="button"
                                aria-pressed={shouldShowThinking}
                                onClick={() => onToggleThinking?.()}
                                className={
                                    shouldShowThinking
                                        ? "rounded p-1.5 text-accent-300"
                                        : "rounded p-1.5 text-primary-500"
                                }
                                title="Show thinking"
                            >
                                <Brain className="size-4" />
                            </button>
                            <button
                                type="button"
                                aria-pressed={shouldShowTools}
                                onClick={() => onToggleTools?.()}
                                className={
                                    shouldShowTools
                                        ? "rounded p-1.5 text-accent-300"
                                        : "rounded p-1.5 text-primary-500"
                                }
                                title="Show tools"
                            >
                                <Wrench className="size-4" />
                            </button>
                        </div>
                        <button
                            type="button"
                            onClick={() =>
                                setShowEmojiPicker((wasPrevious) => !wasPrevious)
                            }
                            disabled={!isConnected || !selectedSessionKey || isSending}
                            className="rounded-full p-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100 focus:bg-primary-600 focus:text-primary-100 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                            title="Insert emoji"
                            aria-label="Insert emoji"
                        >
                            <Smile className="size-5" />
                        </button>
                    </div>
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
                            <Square className="size-4" />
                        ) : (
                            <Mic className="size-4" />
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
                        <Paperclip className="size-4" />
                        Attach
                    </Button>
                    <Button
                        variant="primary"
                        size="md"
                        onClick={onSend}
                        disabled={!canSend || isRecording || isTranscribing}
                        className="w-full px-2 sm:px-4"
                    >
                        <Send className="size-4" />
                        Send
                    </Button>
                </div>
            </div>
        </div>
    );
}
