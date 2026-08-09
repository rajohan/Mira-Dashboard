import { Combobox, ComboboxOption, ComboboxOptions } from "@headlessui/react";
import { LoaderCircle, Mic, MicOff, Paperclip, Send, X } from "lucide-react";
import {
    type ChangeEvent,
    type KeyboardEvent,
    type ReactNode,
    useRef,
    useState,
} from "react";

import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Textarea } from "../ui/Textarea.tsx";
import { ChatAttachmentPicker, ChatAttachmentRow } from "./ChatAttachmentPicker.tsx";
import { ChatAttachmentPreview } from "./ChatAttachmentPreview.tsx";
import {
    chatSlashSuggestions,
    type ChatSlashSuggestion,
    shouldSubmitChatComposer,
} from "./chatComposerModel.ts";
import { ChatEmojiPicker } from "./ChatEmojiPicker.tsx";
import { ChatStopControls } from "./ChatStopControls.tsx";
import type { ChatDraftAttachment, ChatVoiceInputView } from "./chatTypes.ts";

const attachmentAccept =
    "image/*,audio/*,text/*,application/json,application/pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.zip";

interface ChatComposerProps {
    readonly abortableRunIds: readonly string[];
    readonly attachmentError?: string;
    readonly attachments: readonly ChatDraftAttachment[];
    readonly canSend: boolean;
    readonly disabled?: boolean;
    readonly draft: string;
    readonly modelOptions: readonly string[];
    readonly notice?: string;
    readonly onAbort: (runId: string) => void;
    readonly onAttach: (files: FileList) => void;
    readonly onChangeDraft: (draft: string) => void;
    readonly onCancelVoiceInput?: () => void;
    readonly onDismissVoiceInputError?: () => void;
    readonly onRemoveAttachment: (id: string) => void;
    readonly onSend: () => void;
    readonly onStartVoiceInput?: () => void;
    readonly onStopVoiceInput?: () => void;
    readonly settingsControl?: ReactNode;
    readonly thinkingOptions: readonly string[];
    readonly voiceInput?: ChatVoiceInputView;
}

function voiceElapsedLabel(elapsedMs: number): string {
    const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Renders the concurrent-send-safe accessible message composer.
 * @returns Accessible composer controls.
 */
export function ChatComposer({
    abortableRunIds,
    attachmentError,
    attachments,
    canSend,
    disabled = false,
    draft,
    modelOptions,
    notice,
    onAbort,
    onAttach,
    onCancelVoiceInput,
    onChangeDraft,
    onDismissVoiceInputError,
    onRemoveAttachment,
    onSend,
    onStartVoiceInput,
    onStopVoiceInput,
    settingsControl,
    thinkingOptions,
    voiceInput,
}: ChatComposerProps) {
    const fileInput = useRef<HTMLInputElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const [activeSuggestion, setActiveSuggestion] = useState(0);
    const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
    const [previewAttachmentId, setPreviewAttachmentId] = useState<string>();
    const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
    const suggestions = chatSlashSuggestions(draft, modelOptions, thinkingOptions);
    const suggestionsOpen = suggestions.length > 0 && !suggestionsDismissed;
    const previewAttachment = attachments.find(
        (attachment) => attachment.id === previewAttachmentId
    );
    const voiceControlsAvailable =
        voiceInput?.available === true &&
        onStartVoiceInput !== undefined &&
        onStopVoiceInput !== undefined &&
        onCancelVoiceInput !== undefined;

    function applySuggestion(suggestion: ChatSlashSuggestion | undefined): void {
        if (suggestion === undefined) return;
        onChangeDraft(suggestion.replacement);
        setSuggestionsDismissed(true);
        requestAnimationFrame(() => textarea.current?.focus());
    }

    function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
        if (event.nativeEvent.isComposing) return;
        if (suggestionsOpen && event.key === "ArrowDown") {
            event.preventDefault();
            setActiveSuggestion((activeSuggestion + 1) % suggestions.length);
            return;
        }
        if (suggestionsOpen && event.key === "ArrowUp") {
            event.preventDefault();
            setActiveSuggestion(
                (activeSuggestion - 1 + suggestions.length) % suggestions.length
            );
            return;
        }
        if (suggestionsOpen && (event.key === "Enter" || event.key === "Tab")) {
            event.preventDefault();
            applySuggestion(suggestions[activeSuggestion]);
            return;
        }
        if (suggestionsOpen && event.key === "Escape") {
            event.preventDefault();
            setSuggestionsDismissed(true);
            return;
        }
        const coarsePointer =
            globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
        if (
            shouldSubmitChatComposer(
                {
                    isComposing: event.nativeEvent.isComposing,
                    key: event.key,
                    shiftKey: event.shiftKey,
                },
                coarsePointer
            ) &&
            canSend &&
            !disabled
        ) {
            event.preventDefault();
            onSend();
        }
    }

    function handleFiles(event: ChangeEvent<HTMLInputElement>): void {
        if (event.currentTarget.files !== null) onAttach(event.currentTarget.files);
        event.currentTarget.value = "";
    }

    function insertEmoji(emoji: string): void {
        const start = textarea.current?.selectionStart ?? draft.length;
        const end = textarea.current?.selectionEnd ?? start;
        const nextDraft = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
        const nextCaret = start + emoji.length;
        onChangeDraft(nextDraft);
        requestAnimationFrame(() => {
            textarea.current?.focus();
            textarea.current?.setSelectionRange(nextCaret, nextCaret);
        });
    }

    return (
        <section
            aria-label="Message composer"
            className="border-primary-700 bg-primary-800 relative isolate z-20 shrink-0 border-t pt-3"
        >
            {attachments.length > 0 && (
                <ul
                    aria-label="Prepared attachments"
                    className="mb-2 flex max-h-12 min-w-0 flex-wrap gap-2 overflow-y-auto pr-1 sm:max-h-28"
                >
                    {attachments.map((attachment) => (
                        <ChatAttachmentRow
                            attachment={attachment}
                            compact
                            key={attachment.id}
                            onPreview={setPreviewAttachmentId}
                            onRemove={onRemoveAttachment}
                        />
                    ))}
                </ul>
            )}
            {attachmentError !== undefined && (
                <p className="mb-2 text-sm text-red-300" role="alert">
                    {attachmentError}
                </p>
            )}
            {notice !== undefined && (
                <output
                    aria-live="polite"
                    className="text-primary-300 mb-2 block text-sm"
                >
                    {notice}
                </output>
            )}
            {voiceInput?.error !== undefined && (
                <div
                    className="mb-2 flex min-w-0 items-center gap-2 text-sm text-red-300"
                    role="alert"
                >
                    <span className="min-w-0 flex-1 wrap-break-word">
                        {voiceInput.error}
                    </span>
                    {onDismissVoiceInputError !== undefined && (
                        <IconOnlyButton
                            className="shrink-0"
                            icon={X}
                            label="Dismiss voice input error"
                            onClick={onDismissVoiceInputError}
                            size="sm"
                            variant="ghost"
                        />
                    )}
                </div>
            )}
            <Combobox
                as="div"
                className="border-primary-600 bg-primary-950 focus-within:border-accent-400 relative rounded-lg border"
                onChange={(suggestion: ChatSlashSuggestion | null) =>
                    applySuggestion(suggestion ?? undefined)
                }
                value={null as ChatSlashSuggestion | null}
            >
                {suggestionsOpen && (
                    <ComboboxOptions
                        aria-label="Slash commands"
                        className="border-primary-600 bg-primary-900 absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-lg border p-1 shadow-xl outline-none"
                        id="chat-slash-suggestions"
                        modal={false}
                        static
                    >
                        {suggestions.map((suggestion, index) => (
                            <ComboboxOption
                                className={cn(
                                    "group hover:bg-primary-700 focus-visible:ring-accent-400 data-focus:bg-primary-700 block w-full cursor-pointer rounded-md px-3 py-2 text-left outline-none focus-visible:ring-2",
                                    index === activeSuggestion && "bg-primary-700"
                                )}
                                id={`chat-slash-suggestion-${index}`}
                                key={suggestion.title}
                                onMouseEnter={() => setActiveSuggestion(index)}
                                value={suggestion}
                            >
                                <span className="text-primary-100 block font-mono text-sm">
                                    {suggestion.title}
                                </span>
                                <span
                                    className={cn(
                                        "text-primary-400 group-hover:text-primary-200 group-data-focus:text-primary-200 block text-xs",
                                        index === activeSuggestion && "text-primary-200"
                                    )}
                                >
                                    {suggestion.description}
                                </span>
                            </ComboboxOption>
                        ))}
                    </ComboboxOptions>
                )}
                <div>
                    <Textarea
                        aria-activedescendant={
                            suggestionsOpen
                                ? `chat-slash-suggestion-${activeSuggestion}`
                                : undefined
                        }
                        aria-autocomplete="list"
                        aria-controls={
                            suggestionsOpen ? "chat-slash-suggestions" : undefined
                        }
                        aria-haspopup="listbox"
                        aria-label="Message"
                        className="min-h-24 resize-none rounded-b-none border-0 bg-transparent shadow-none sm:min-h-28"
                        disabled={disabled}
                        enterKeyHint="enter"
                        onBlur={(event) => {
                            if (
                                event.relatedTarget instanceof HTMLElement &&
                                event.relatedTarget.getAttribute("role") === "option"
                            ) {
                                return;
                            }
                            setSuggestionsDismissed(true);
                        }}
                        onChange={(event) => {
                            setActiveSuggestion(0);
                            setSuggestionsDismissed(false);
                            onChangeDraft(event.currentTarget.value);
                        }}
                        onKeyDown={handleKeyDown}
                        placeholder="Message Mira, attach files, or type / for commands"
                        ref={textarea}
                        rows={4}
                        value={draft}
                    />
                </div>
                <div
                    className="border-primary-700 flex min-w-0 flex-row items-center justify-between gap-1 border-t p-2"
                    data-testid="chat-composer-toolbar"
                >
                    <fieldset
                        aria-label="Composer tools"
                        className="m-0 flex shrink-0 items-center border-0 p-0"
                    >
                        {settingsControl}
                    </fieldset>
                    <fieldset
                        aria-label="Composer actions"
                        className="m-0 ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-1 border-0 p-0"
                    >
                        {voiceInput?.phase !== "recording" &&
                            voiceInput?.phase !== "transcribing" && (
                                <ChatEmojiPicker
                                    disabled={disabled}
                                    onSelect={insertEmoji}
                                />
                            )}
                        <input
                            accept={attachmentAccept}
                            aria-label="Choose chat attachments"
                            className="sr-only"
                            multiple
                            onChange={handleFiles}
                            ref={fileInput}
                            tabIndex={-1}
                            type="file"
                        />
                        {voiceControlsAvailable && voiceInput.phase === "idle" && (
                            <IconOnlyButton
                                className="min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9"
                                disabled={disabled}
                                icon={Mic}
                                label="Start voice input"
                                onClick={onStartVoiceInput}
                                size="sm"
                                variant="ghost"
                            />
                        )}
                        {voiceControlsAvailable && voiceInput.phase === "recording" && (
                            <>
                                <Button
                                    aria-label="Stop and transcribe"
                                    className="min-h-10 min-w-10 shrink-0 gap-1.5 rounded-full border border-red-700 bg-red-700 px-2 text-white shadow-sm shadow-red-950/40 hover:border-red-600 hover:bg-red-600 hover:text-white sm:min-h-9 sm:px-2.5"
                                    onClick={onStopVoiceInput}
                                    size="sm"
                                    title="Stop and transcribe recording"
                                    variant="ghost"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="size-2 animate-pulse rounded-full bg-white motion-reduce:animate-none"
                                    />
                                    <Icon icon={MicOff} size="sm" tone="inherit" />
                                    <span className="hidden text-xs font-medium sm:inline">
                                        Recording
                                    </span>
                                    <span
                                        aria-hidden="true"
                                        className="hidden font-mono text-xs tabular-nums md:inline"
                                    >
                                        {voiceElapsedLabel(voiceInput.elapsedMs)}
                                    </span>
                                    <output
                                        aria-label="Voice recording duration"
                                        className="sr-only"
                                    >
                                        {voiceElapsedLabel(voiceInput.elapsedMs)}
                                    </output>
                                </Button>
                                <IconOnlyButton
                                    className="min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9"
                                    icon={X}
                                    label="Cancel voice input"
                                    onClick={onCancelVoiceInput}
                                    size="sm"
                                    variant="ghost"
                                />
                            </>
                        )}
                        {voiceControlsAvailable &&
                            voiceInput.phase === "transcribing" && (
                                <>
                                    <output
                                        aria-label="Voice input status"
                                        className="text-primary-300 inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 px-0 text-xs sm:min-h-9 sm:min-w-9"
                                    >
                                        <Icon
                                            className="animate-spin motion-reduce:animate-none"
                                            icon={LoaderCircle}
                                            size="sm"
                                            tone="inherit"
                                        />
                                        <span className="sr-only">Transcribing…</span>
                                    </output>
                                    <IconOnlyButton
                                        className="min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9"
                                        icon={X}
                                        label="Cancel voice input"
                                        onClick={onCancelVoiceInput}
                                        size="sm"
                                        variant="ghost"
                                    />
                                </>
                            )}
                        {voiceInput?.phase !== "recording" &&
                            voiceInput?.phase !== "transcribing" && (
                                <IconOnlyButton
                                    className="min-h-10 min-w-10 px-0 sm:min-h-9 sm:min-w-9"
                                    disabled={disabled}
                                    icon={Paperclip}
                                    label="Attach files"
                                    onClick={() => setAttachmentPickerOpen(true)}
                                    size="sm"
                                    variant="ghost"
                                />
                            )}
                        <ChatStopControls onAbort={onAbort} runIds={abortableRunIds} />
                        {voiceInput?.phase !== "recording" &&
                            voiceInput?.phase !== "transcribing" && (
                                <IconOnlyButton
                                    className="min-h-10 min-w-10 px-0 sm:ml-auto sm:min-h-9 sm:min-w-9"
                                    disabled={disabled || !canSend}
                                    icon={Send}
                                    label="Send message"
                                    onClick={onSend}
                                    size="sm"
                                />
                            )}
                    </fieldset>
                </div>
            </Combobox>
            <ChatAttachmentPicker
                attachments={attachments}
                disabled={disabled}
                error={attachmentError}
                onChooseFiles={() => fileInput.current?.click()}
                onClose={() => setAttachmentPickerOpen(false)}
                onFilesSelected={onAttach}
                onPreview={setPreviewAttachmentId}
                onRemove={onRemoveAttachment}
                open={attachmentPickerOpen}
            />
            <ChatAttachmentPreview
                attachment={previewAttachment}
                key={previewAttachment?.id ?? "closed-preview"}
                onClose={() => setPreviewAttachmentId(undefined)}
            />
        </section>
    );
}
