import {
    Combobox,
    ComboboxOption,
    ComboboxOptions,
    Popover,
    PopoverButton,
    PopoverPanel,
} from "@headlessui/react";
import {
    ArrowUp,
    Brain,
    Mic,
    MicOff,
    Minimize2,
    Paperclip,
    Pin,
    Settings,
    Settings2,
    SlidersHorizontal,
    Smile,
    Square,
    Wrench,
    X,
} from "lucide-react";
import {
    type DragEvent as ReactDragEvent,
    type KeyboardEvent as ReactKeyboardEvent,
    type ReactNode,
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
import {
    ChatAttachmentPickerModal,
    hasFilesInDataTransfer,
} from "./ChatAttachmentPickerModal";
import type {
    ChatAttachmentInputSource,
    ChatPreviewItem,
    ChatSendAttachment,
} from "./chatTypes";
import {
    CHAT_ATTACHMENT_ACCEPT,
    type ChatModelOption,
    chatSpeedOptions,
    chatThinkingOptions,
    MAX_ATTACHMENTS,
    previewFromSendAttachment,
    selectedChatSpeed,
} from "./chatUtilities";
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

/** Provides props for a composer overlay header. */
interface PanelHeaderProperties {
    title: string;
    closeLabel: string;
    className?: string;
    onClose: () => void;
}

/** Renders a consistent title and close action for composer panels. */
function PanelHeader({
    title,
    closeLabel,
    className = "",
    onClose,
}: PanelHeaderProperties) {
    return (
        <div className={`flex items-center justify-between ${className}`}>
            <span className="text-xs font-medium tracking-wide text-primary-400 uppercase">
                {title}
            </span>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                className="p-1 text-primary-400 hover:text-primary-100"
                aria-label={closeLabel}
            >
                <X className="size-4" />
            </Button>
        </div>
    );
}

/** Renders one accessible toggle inside the chat display drawer. */
function DisplayToggle({
    label,
    description,
    isPressed,
    isDisabled = false,
    icon,
    onToggle,
}: {
    label: string;
    description: string;
    isPressed: boolean;
    isDisabled?: boolean;
    icon: ReactNode;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            aria-label={label}
            aria-pressed={isPressed}
            disabled={isDisabled}
            onClick={onToggle}
            className="flex w-full items-center gap-2 rounded-md border border-primary-700 bg-primary-900/50 px-2.5 py-2 text-left transition hover:border-primary-600 hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-40"
        >
            <span className={isPressed ? "text-accent-300" : "text-primary-500"}>
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-primary-100">
                    {label}
                </span>
                <span className="block text-[11px] text-primary-400">{description}</span>
            </span>
            <span className="shrink-0 text-[10px] tracking-wide text-primary-400 uppercase">
                {isPressed ? "On" : "Off"}
            </span>
        </button>
    );
}

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
    attachmentPickerError?: string;
    attachments: ChatSendAttachment[];
    canSend: boolean;
    canStop?: boolean;
    draft: string;
    fileInputReference: RefObject<HTMLInputElement | undefined>;
    isConnected: boolean;
    isRecording: boolean;
    isSending: boolean;
    isStopping?: boolean;
    isTranscribing: boolean;
    selectedSessionKey: string;
    selectedSession?: Session;
    modelOptions?: ChatModelOption[];
    shouldShowThinking?: boolean;
    shouldShowTools?: boolean;
    shouldExpandToolDetails?: boolean;
    shouldKeepThinkingAfterFinal?: boolean;
    compactDisabled?: boolean;
    preferenceControlsDisabled?: boolean;
    isCompacting?: boolean;
    slashCommandSuggestions: SlashCommandSuggestion[];
    onApplySlashSuggestion: (value: string) => void;
    onAttachFiles: (
        files: FileList | undefined,
        source: ChatAttachmentInputSource
    ) => void;
    onChangeDraft: (value: string) => void;
    onDismissAttachmentPickerError?: () => void;
    onPreview: (isPreview: ChatPreviewItem) => void;
    onRemoveAttachment: (attachmentId: string) => void;
    onSend: () => void;
    onStop?: () => void;
    onToggleRecording: () => void;
    onToggleThinking?: () => void;
    onToggleTools?: () => void;
    onToggleToolDetailsExpansion?: () => void;
    onToggleKeepThinkingAfterFinal?: () => void;
    onSelectThinkingLevel?: (value: string) => void;
    onSelectSpeed?: (value: string) => void;
    onSelectModel?: (value: string) => void;
    onCompact?: () => void;
}

/** Renders the chat composer UI. */
export function ChatComposer({
    attachmentPickerError,
    attachments,
    canSend,
    canStop = false,
    draft,
    fileInputReference,
    isConnected,
    isRecording,
    isSending,
    isStopping = false,
    isTranscribing,
    selectedSessionKey,
    selectedSession,
    modelOptions = [],
    shouldShowThinking,
    shouldShowTools,
    shouldExpandToolDetails = false,
    shouldKeepThinkingAfterFinal = false,
    compactDisabled,
    preferenceControlsDisabled,
    isCompacting,
    slashCommandSuggestions,
    onApplySlashSuggestion,
    onAttachFiles,
    onChangeDraft,
    onDismissAttachmentPickerError,
    onPreview,
    onRemoveAttachment,
    onSend,
    onStop,
    onToggleRecording,
    onToggleThinking,
    onToggleTools,
    onToggleToolDetailsExpansion,
    onToggleKeepThinkingAfterFinal,
    onSelectThinkingLevel,
    onSelectSpeed,
    onSelectModel,
    onCompact,
}: ChatComposerProperties) {
    const [activeSlashSuggestionIndex, setActiveSlashSuggestionIndex] = useState(0);
    const [isAttachmentPickerOpen, setIsAttachmentPickerOpen] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [slashSuggestionsDismissed, setSlashSuggestionsDismissed] = useState(false);
    const fileDragDepthReference = useRef(0);
    const textareaReference = useRef<HTMLTextAreaElement | undefined>(undefined);
    const slashOptionsReference = useRef<HTMLDivElement | null>(null);
    const shouldShowSlashSuggestions =
        !slashSuggestionsDismissed && slashCommandSuggestions.length > 0;
    const selectedSlashSuggestionIndex = Math.min(
        activeSlashSuggestionIndex,
        Math.max(0, slashCommandSuggestions.length - 1)
    );
    const modelSelectOptions = modelOptions.map((option) => ({
        value: option.id || option.name || option.label || "",
        label: option.label || option.name || option.id || "Unknown",
    }));
    const currentModel = selectedSession?.model || "";
    const canAttachFiles = Boolean(
        isConnected &&
        selectedSessionKey &&
        !isSending &&
        !isRecording &&
        attachments.length < MAX_ATTACHMENTS
    );

    useEffect(() => {
        if (!shouldShowSlashSuggestions) {
            return;
        }

        const dismissSlashSuggestionsOutsideMenu = (event: PointerEvent) => {
            const target = event.target;
            if (
                !(target instanceof Node) ||
                textareaReference.current?.contains(target) ||
                slashOptionsReference.current?.contains(target)
            ) {
                return;
            }
            setSlashSuggestionsDismissed(true);
        };

        document.addEventListener("pointerdown", dismissSlashSuggestionsOutsideMenu, {
            capture: true,
        });
        return () =>
            document.removeEventListener(
                "pointerdown",
                dismissSlashSuggestionsOutsideMenu,
                { capture: true }
            );
    }, [shouldShowSlashSuggestions]);

    useEffect(() => {
        const preventPageFileDrop = (event: globalThis.DragEvent) => {
            if (!event.dataTransfer || !hasFilesInDataTransfer(event.dataTransfer)) {
                return;
            }
            event.preventDefault();
            if (event.type === "drop") {
                fileDragDepthReference.current = 0;
                setIsDraggingFiles(false);
            }
        };

        const listenerOptions = { capture: true };
        addEventListener("dragover", preventPageFileDrop, listenerOptions);
        addEventListener("drop", preventPageFileDrop, listenerOptions);
        return () => {
            removeEventListener("dragover", preventPageFileDrop, listenerOptions);
            removeEventListener("drop", preventPageFileDrop, listenerOptions);
        };
    }, []);

    if (
        currentModel &&
        modelSelectOptions.every((option) => option.value !== currentModel)
    ) {
        modelSelectOptions.unshift({ value: currentModel, label: currentModel });
    }
    if (modelSelectOptions.length === 0) {
        modelSelectOptions.push({ value: "", label: "Default" });
    }

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

        setTimeout(() => {
            textarea?.focus();
            textarea?.setSelectionRange(nextCursor, nextCursor);
        }, 0);
    };

    /** Applies a slash suggestion and returns focus to the composer. */
    const applySlashSuggestion = (suggestion: SlashCommandSuggestion) => {
        setSlashSuggestionsDismissed(!suggestion.value.endsWith(" "));
        onApplySlashSuggestion(suggestion.value);
        requestAnimationFrame(() => textareaReference.current?.focus());
    };

    /** Shows a drop affordance while files are dragged over the composer. */
    const handleFileDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        fileDragDepthReference.current += 1;
        if (canAttachFiles) {
            setIsDraggingFiles(true);
        }
    };

    /** Keeps operating-system file drops inside the composer. */
    const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = canAttachFiles ? "copy" : "none";
    };

    /** Clears the drop affordance once the drag leaves the composer. */
    const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        fileDragDepthReference.current = Math.max(0, fileDragDepthReference.current - 1);
        if (fileDragDepthReference.current === 0) {
            setIsDraggingFiles(false);
        }
    };

    /** Attaches files dropped directly onto the composer. */
    const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        fileDragDepthReference.current = 0;
        setIsDraggingFiles(false);
        if (canAttachFiles && event.dataTransfer.files.length > 0) {
            onAttachFiles(event.dataTransfer.files, "composer");
        }
    };

    /** Attaches a file-picker selection while keeping the custom picker open. */
    const handleFilesSelected = (files: FileList | undefined) => {
        if (!canAttachFiles || !files || files.length === 0) {
            return;
        }
        onAttachFiles(files, "picker");
    };

    return (
        <div
            onDragEnter={handleFileDragEnter}
            onDragOver={handleFileDragOver}
            onDragLeave={handleFileDragLeave}
            onDrop={handleFileDrop}
            className="relative mt-3 border-t border-primary-700 pt-3 sm:mt-4 sm:pt-4"
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
                                    onPreview(previewFromSendAttachment(attachment))
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

            <div>
                <input
                    ref={(element) => {
                        fileInputReference.current = element ?? undefined;
                    }}
                    type="file"
                    accept={CHAT_ATTACHMENT_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={(event) => {
                        handleFilesSelected(event.currentTarget.files ?? undefined);
                        event.currentTarget.value = "";
                    }}
                />
                {isDraggingFiles ? (
                    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent-400 bg-primary-950/90 px-4 text-center text-sm font-medium text-accent-200 shadow-xl">
                        Drop files to attach
                    </div>
                ) : undefined}
                <Combobox
                    value={undefined as SlashCommandSuggestion | undefined}
                    onChange={(suggestion: SlashCommandSuggestion | null | undefined) => {
                        if (suggestion) {
                            applySlashSuggestion(suggestion);
                        }
                    }}
                    as="div"
                    className="relative min-w-0 rounded-lg border border-primary-600 bg-primary-800 transition-colors focus-within:border-accent-500 hover:border-primary-500 focus-within:hover:border-accent-500"
                >
                    {shouldShowSlashSuggestions ? (
                        <ComboboxOptions
                            ref={slashOptionsReference}
                            static
                            modal={false}
                            id="chat-slash-command-options"
                            className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border border-primary-700 bg-primary-900 shadow-2xl outline-none"
                        >
                            <PanelHeader
                                title="Slash commands"
                                closeLabel="Close slash commands"
                                onClose={() => {
                                    setSlashSuggestionsDismissed(true);
                                    requestAnimationFrame(() =>
                                        textareaReference.current?.focus()
                                    );
                                }}
                                className="border-b border-primary-700 px-3 py-2"
                            />
                            <div className="max-h-72 overflow-y-auto py-1">
                                {slashCommandSuggestions.map((suggestion, index) => (
                                    <ComboboxOption
                                        key={suggestion.value}
                                        id={`chat-slash-command-option-${index}`}
                                        value={suggestion}
                                        onMouseEnter={() =>
                                            setActiveSlashSuggestionIndex(index)
                                        }
                                        className={`flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-primary-800 focus:outline-none data-focus:bg-primary-800 ${
                                            index === selectedSlashSuggestionIndex
                                                ? "bg-primary-800"
                                                : ""
                                        }`}
                                    >
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-sm text-primary-100">
                                                {suggestion.title}
                                            </span>
                                            <span className="mt-0.5 block truncate text-xs text-primary-400">
                                                {suggestion.description}
                                            </span>
                                        </span>
                                    </ComboboxOption>
                                ))}
                            </div>
                        </ComboboxOptions>
                    ) : undefined}
                    <Textarea
                        aria-label="Message"
                        ref={(element) => {
                            textareaReference.current = element ?? undefined;
                        }}
                        role="combobox"
                        aria-autocomplete="list"
                        aria-expanded={shouldShowSlashSuggestions}
                        aria-controls={
                            shouldShowSlashSuggestions
                                ? "chat-slash-command-options"
                                : undefined
                        }
                        aria-activedescendant={
                            shouldShowSlashSuggestions
                                ? `chat-slash-command-option-${selectedSlashSuggestionIndex}`
                                : undefined
                        }
                        value={draft}
                        onChange={(event) => {
                            setSlashSuggestionsDismissed(false);
                            setActiveSlashSuggestionIndex(0);
                            onChangeDraft(event.target.value);
                        }}
                        onBlur={(event) => {
                            const nextFocusedElement = event.relatedTarget;
                            if (
                                nextFocusedElement instanceof Node &&
                                slashOptionsReference.current?.contains(
                                    nextFocusedElement
                                )
                            ) {
                                return;
                            }
                            setSlashSuggestionsDismissed(true);
                        }}
                        onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing) {
                                return;
                            }

                            if (shouldShowSlashSuggestions && event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveSlashSuggestionIndex(
                                    (selectedSlashSuggestionIndex + 1) %
                                        slashCommandSuggestions.length
                                );
                                return;
                            }

                            if (shouldShowSlashSuggestions && event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveSlashSuggestionIndex(
                                    (selectedSlashSuggestionIndex -
                                        1 +
                                        slashCommandSuggestions.length) %
                                        slashCommandSuggestions.length
                                );
                                return;
                            }

                            const shouldUseEnterForAction = shouldSendFromEnter(event);
                            if (!shouldUseEnterForAction && event.key === "Enter") {
                                event.stopPropagation();
                                return;
                            }
                            const currentDraft = event.currentTarget.value.trim();
                            const isExactSlashSuggestion = slashCommandSuggestions.some(
                                (suggestion) =>
                                    !suggestion.requiresArgument &&
                                    suggestion.value.trimEnd() === currentDraft
                            );
                            if (
                                shouldShowSlashSuggestions &&
                                ((event.key === "Tab" && !event.shiftKey) ||
                                    (shouldUseEnterForAction && !isExactSlashSuggestion))
                            ) {
                                event.preventDefault();
                                const suggestion =
                                    slashCommandSuggestions[selectedSlashSuggestionIndex];
                                if (suggestion) {
                                    applySlashSuggestion(suggestion);
                                }
                                return;
                            }

                            if (shouldShowSlashSuggestions && event.key === "Escape") {
                                event.preventDefault();
                                setSlashSuggestionsDismissed(true);
                                return;
                            }

                            if (shouldUseEnterForAction && canSend) {
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
                        className="block min-h-24 w-full resize-none rounded-t-lg border-0 bg-transparent px-3 py-2 text-base text-primary-100 placeholder-primary-500 hover:border-0 focus:border-0 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-32 sm:text-sm"
                    />
                    <div className="flex min-h-10 items-center justify-between rounded-b-lg border-t border-primary-600 bg-primary-700 px-2 py-1">
                        <div className="flex items-center gap-1">
                            <Popover className="relative">
                                {({ close }) => (
                                    <>
                                        <PopoverButton
                                            aria-label="Model and response settings"
                                            title="Response settings"
                                            className="flex items-center rounded p-1.5 text-primary-400 outline-none hover:bg-primary-700 hover:text-primary-100 data-focus:bg-primary-700 data-focus:text-primary-100"
                                        >
                                            <Settings2 className="size-4" />
                                        </PopoverButton>
                                        <PopoverPanel
                                            anchor={{ to: "top start", gap: 11 }}
                                            className="z-50 w-72 space-y-3 rounded-lg border border-primary-600 bg-primary-800 p-3 text-sm shadow-xl outline-none"
                                        >
                                            <PanelHeader
                                                title="Response settings"
                                                closeLabel="Close response settings"
                                                onClose={() => close()}
                                            />
                                            <div className="space-y-1">
                                                <div className="text-xs font-medium text-primary-400">
                                                    Model
                                                </div>
                                                <Select
                                                    ariaLabel="Model"
                                                    width="w-full"
                                                    value={selectedSession?.model || ""}
                                                    disabled={
                                                        !selectedSessionKey ||
                                                        preferenceControlsDisabled
                                                    }
                                                    onChange={(value) =>
                                                        onSelectModel?.(value)
                                                    }
                                                    options={modelSelectOptions}
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-xs font-medium text-primary-400">
                                                    Thinking
                                                </div>
                                                <Select
                                                    ariaLabel="Thinking"
                                                    width="w-full"
                                                    value={
                                                        selectedSession?.thinkingLevel ||
                                                        ""
                                                    }
                                                    disabled={
                                                        !selectedSessionKey ||
                                                        preferenceControlsDisabled
                                                    }
                                                    onChange={(value) =>
                                                        onSelectThinkingLevel?.(value)
                                                    }
                                                    options={chatThinkingOptions(
                                                        selectedSession
                                                    )}
                                                />
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-xs font-medium text-primary-400">
                                                    Speed
                                                </div>
                                                <Select
                                                    ariaLabel="Speed"
                                                    width="w-full"
                                                    value={selectedChatSpeed(
                                                        selectedSession
                                                    )}
                                                    disabled={
                                                        !selectedSessionKey ||
                                                        preferenceControlsDisabled
                                                    }
                                                    onChange={(value) =>
                                                        onSelectSpeed?.(value)
                                                    }
                                                    options={chatSpeedOptions(
                                                        selectedSession
                                                    )}
                                                />
                                            </div>
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                className="w-full justify-center"
                                                disabled={
                                                    !selectedSessionKey ||
                                                    compactDisabled ||
                                                    isCompacting
                                                }
                                                onClick={() => onCompact?.()}
                                            >
                                                <Minimize2 className="size-4" />
                                                {isCompacting
                                                    ? "Compacting…"
                                                    : "Compact context"}
                                            </Button>
                                        </PopoverPanel>
                                    </>
                                )}
                            </Popover>
                            <Popover className="relative">
                                {({ close }) => (
                                    <>
                                        <PopoverButton
                                            aria-label="Chat display settings"
                                            title="Chat display settings"
                                            disabled={!selectedSessionKey}
                                            className="flex items-center rounded p-1.5 text-primary-400 outline-none hover:bg-primary-700 hover:text-primary-100 disabled:cursor-not-allowed disabled:opacity-40 data-focus:bg-primary-700 data-focus:text-primary-100"
                                        >
                                            <Settings className="size-4" />
                                        </PopoverButton>
                                        <PopoverPanel
                                            anchor={{ to: "top start", gap: 11 }}
                                            className="z-50 w-80 space-y-2 rounded-lg border border-primary-600 bg-primary-800 p-3 text-sm shadow-xl outline-none"
                                        >
                                            <PanelHeader
                                                title="Chat display"
                                                closeLabel="Close chat display settings"
                                                onClose={() => close()}
                                            />
                                            <DisplayToggle
                                                label="Show thinking"
                                                description="Show thinking and working updates"
                                                isPressed={Boolean(shouldShowThinking)}
                                                icon={<Brain className="size-4" />}
                                                onToggle={() => onToggleThinking?.()}
                                            />
                                            <DisplayToggle
                                                label="Show tools"
                                                description="Show tool calls and results"
                                                isPressed={Boolean(shouldShowTools)}
                                                icon={<Wrench className="size-4" />}
                                                onToggle={() => onToggleTools?.()}
                                            />
                                            <DisplayToggle
                                                label="Keep thinking after final answer"
                                                description="Retain thinking after a run completes"
                                                isPressed={shouldKeepThinkingAfterFinal}
                                                isDisabled={!shouldShowThinking}
                                                icon={<Pin className="size-4" />}
                                                onToggle={() =>
                                                    onToggleKeepThinkingAfterFinal?.()
                                                }
                                            />
                                            <DisplayToggle
                                                label="Expand tool call details"
                                                description="Apply to current and future tool bubbles"
                                                isPressed={shouldExpandToolDetails}
                                                icon={
                                                    <SlidersHorizontal className="size-4" />
                                                }
                                                onToggle={() =>
                                                    onToggleToolDetailsExpansion?.()
                                                }
                                            />
                                        </PopoverPanel>
                                    </>
                                )}
                            </Popover>
                        </div>
                        <div className="flex items-center gap-1">
                            <Popover className="relative">
                                {({ close }) => (
                                    <>
                                        <PopoverButton
                                            as={Button}
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            disabled={
                                                !isConnected ||
                                                !selectedSessionKey ||
                                                isSending
                                            }
                                            className="rounded-full p-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100 focus:bg-primary-600 focus:text-primary-100 disabled:opacity-40"
                                            title="Insert emoji"
                                            aria-label="Insert emoji"
                                        >
                                            <Smile className="size-5" />
                                        </PopoverButton>
                                        <PopoverPanel
                                            anchor={{ to: "top end", gap: 8 }}
                                            className="z-50 w-80 rounded-xl border border-primary-700 bg-primary-900 p-2 shadow-2xl outline-none"
                                        >
                                            <PanelHeader
                                                title="Emoji"
                                                closeLabel="Close emoji picker"
                                                onClose={() => close()}
                                                className="mb-2 px-1"
                                            />
                                            <div className="grid max-h-64 grid-cols-6 gap-1 overflow-y-auto">
                                                {CHAT_EMOJIS.map((emoji) => (
                                                    <Button
                                                        key={emoji}
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => {
                                                            insertEmoji(emoji);
                                                            close();
                                                        }}
                                                        className="p-2.5 text-xl hover:bg-primary-800 focus:bg-primary-800"
                                                        aria-label={`Insert ${emoji}`}
                                                    >
                                                        {emoji}
                                                    </Button>
                                                ))}
                                            </div>
                                        </PopoverPanel>
                                    </>
                                )}
                            </Popover>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={onToggleRecording}
                                disabled={
                                    !isConnected ||
                                    !selectedSessionKey ||
                                    isSending ||
                                    isTranscribing
                                }
                                title={
                                    isRecording ? "Stop recording" : "Record voice input"
                                }
                                aria-label={
                                    isRecording ? "Stop recording" : "Record voice input"
                                }
                                className={[
                                    "h-8 rounded-full border",
                                    isRecording
                                        ? "gap-1.5 border-red-500 bg-red-500 px-2.5 text-white shadow-sm shadow-red-950/40 hover:border-red-400 hover:bg-red-600 hover:text-white"
                                        : "border-transparent px-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100",
                                ].join(" ")}
                            >
                                {isRecording ? (
                                    <>
                                        <span className="size-2 animate-pulse rounded-full bg-white" />
                                        <MicOff className="size-4" />
                                        <span className="hidden text-xs font-medium sm:inline">
                                            Recording
                                        </span>
                                    </>
                                ) : (
                                    <Mic className="size-4" />
                                )}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    onDismissAttachmentPickerError?.();
                                    setIsAttachmentPickerOpen(true);
                                }}
                                disabled={!canAttachFiles}
                                title="Attach files"
                                aria-label="Attach files"
                                className="rounded-full p-2 text-primary-400 hover:bg-primary-600 hover:text-primary-100"
                            >
                                <Paperclip className="size-4" />
                            </Button>
                            {(canStop || isStopping) && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={onStop}
                                    disabled={!canStop}
                                    title="Stop"
                                    aria-label="Stop"
                                    className="size-8 shrink-0 rounded-full border border-red-500/60 bg-transparent p-0 text-red-500/80 hover:border-red-500/90 hover:bg-transparent hover:text-red-500"
                                >
                                    <Square className="size-3.5 fill-current" />
                                </Button>
                            )}
                            <Button
                                type="button"
                                variant="primary"
                                size="sm"
                                onClick={onSend}
                                disabled={
                                    !canSend ||
                                    isRecording ||
                                    isTranscribing ||
                                    isStopping
                                }
                                title="Send"
                                aria-label="Send"
                                className="size-8 shrink-0 rounded-full p-0"
                            >
                                <ArrowUp className="size-4" />
                            </Button>
                        </div>
                    </div>
                </Combobox>
            </div>
            <ChatAttachmentPickerModal
                attachments={attachments}
                error={attachmentPickerError}
                isDisabled={!canAttachFiles}
                isOpen={isAttachmentPickerOpen}
                onChooseFiles={() => fileInputReference.current?.click()}
                onClose={() => {
                    setIsAttachmentPickerOpen(false);
                    onDismissAttachmentPickerError?.();
                }}
                onFilesSelected={handleFilesSelected}
                onRemoveAttachment={onRemoveAttachment}
            />
        </div>
    );
}
