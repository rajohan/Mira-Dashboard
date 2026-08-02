import { Combobox, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { Paperclip, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

import type { Session } from "../../../../../contracts/sessions";
import { formatSize } from "../../../utils/format";
import { Textarea } from "../../ui/Textarea";
import { ChatAttachmentPickerModal } from "./ChatAttachmentPickerModal";
import {
    CHAT_ATTACHMENT_ACCEPT,
    previewFromSendAttachment,
} from "./chatAttachmentUtilities";
import { ChatComposerToolbar, PanelHeader } from "./ChatComposerToolbar";
import { type ChatModelOption } from "./chatSettings";
import type {
    ChatAttachmentInputSource,
    ChatPreviewItem,
    ChatSendAttachment,
} from "./chatTypes";
import type { SlashCommandSuggestion } from "./slashCommands";
import { useChatComposerController } from "./useChatComposerController";

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
    fileInputRef: RefObject<HTMLInputElement | undefined>;
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

/**
 * Renders the chat composer UI.
 * @returns Rendered the chat composer UI.
 */
export function ChatComposer({
    attachmentPickerError,
    attachments,
    canSend,
    canStop = false,
    draft,
    fileInputRef,
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
    const {
        applySlashSuggestion,
        canAttachFiles,
        handleFileDragEnter,
        handleFileDragLeave,
        handleFileDragOver,
        handleFileDrop,
        handleFilesSelected,
        insertEmoji,
        isAttachmentPickerOpen,
        isDraggingFiles,
        modelSelectOptions,
        selectedSlashSuggestionIndex,
        setActiveSlashSuggestionIndex,
        setIsAttachmentPickerOpen,
        setSlashSuggestionsDismissed,
        shouldShowSlashSuggestions,
        slashOptionsRef,
        textareaRef,
    } = useChatComposerController({
        attachments,
        draft,
        isConnected,
        isRecording,
        isSending,
        modelOptions,
        onApplySlashSuggestion,
        onAttachFiles,
        onChangeDraft,
        selectedSession,
        selectedSessionKey,
        slashCommandSuggestions,
    });

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
                        fileInputRef.current = element ?? undefined;
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
                            ref={slashOptionsRef}
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
                                        textareaRef.current?.focus()
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
                            textareaRef.current = element ?? undefined;
                        }}
                        aria-autocomplete="list"
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
                        aria-haspopup="listbox"
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
                                slashOptionsRef.current?.contains(nextFocusedElement)
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
                        className="block min-h-24 w-full resize-none rounded-t-lg border-0 bg-transparent px-3 py-2 text-base text-primary-100 placeholder-primary-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-32 sm:text-sm"
                    />
                    <ChatComposerToolbar
                        canAttachFiles={canAttachFiles}
                        canSend={canSend}
                        canStop={canStop}
                        compactDisabled={compactDisabled}
                        insertEmoji={insertEmoji}
                        isCompacting={isCompacting}
                        isConnected={isConnected}
                        isRecording={isRecording}
                        isSending={isSending}
                        isStopping={isStopping}
                        isTranscribing={isTranscribing}
                        modelSelectOptions={modelSelectOptions}
                        onCompact={onCompact}
                        onOpenAttachmentPicker={() => {
                            onDismissAttachmentPickerError?.();
                            setIsAttachmentPickerOpen(true);
                        }}
                        onSelectModel={onSelectModel}
                        onSelectSpeed={onSelectSpeed}
                        onSelectThinkingLevel={onSelectThinkingLevel}
                        onSend={onSend}
                        onStop={onStop}
                        onToggleKeepThinkingAfterFinal={onToggleKeepThinkingAfterFinal}
                        onToggleRecording={onToggleRecording}
                        onToggleThinking={onToggleThinking}
                        onToggleToolDetailsExpansion={onToggleToolDetailsExpansion}
                        onToggleTools={onToggleTools}
                        preferenceControlsDisabled={preferenceControlsDisabled}
                        selectedSession={selectedSession}
                        selectedSessionKey={selectedSessionKey}
                        shouldExpandToolDetails={shouldExpandToolDetails}
                        shouldKeepThinkingAfterFinal={shouldKeepThinkingAfterFinal}
                        shouldShowThinking={shouldShowThinking}
                        shouldShowTools={shouldShowTools}
                    />
                </Combobox>
            </div>
            <ChatAttachmentPickerModal
                attachments={attachments}
                error={attachmentPickerError}
                isDisabled={!canAttachFiles}
                isOpen={isAttachmentPickerOpen}
                onChooseFiles={() => fileInputRef.current?.click()}
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
