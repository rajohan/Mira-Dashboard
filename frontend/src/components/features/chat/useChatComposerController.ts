import type { DragEvent as ReactDragEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { Session } from "../../../../../contracts/sessions";
import { subscribeToGlobalEvent } from "../../../lib/globalEvents";
import type { ChatAttachmentInputSource, ChatSendAttachment } from "./chatTypes";
import {
    hasFilesInDataTransfer,
    type ChatModelOption,
    MAX_ATTACHMENTS,
} from "./chatUtilities";
import type { SlashCommandSuggestion } from "./slashCommands";

interface ChatComposerControllerOptions {
    attachments: ChatSendAttachment[];
    draft: string;
    isConnected: boolean;
    isRecording: boolean;
    isSending: boolean;
    modelOptions: ChatModelOption[];
    onApplySlashSuggestion: (value: string) => void;
    onAttachFiles: (
        files: FileList | undefined,
        source: ChatAttachmentInputSource
    ) => void;
    onChangeDraft: (value: string) => void;
    selectedSession?: Session;
    selectedSessionKey: string;
    slashCommandSuggestions: SlashCommandSuggestion[];
}

/**
 * Owns composer-local slash, emoji, picker, and drag-and-drop behavior.
 * @returns Composer state, refs, and event handlers.
 */
export function useChatComposerController({
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
}: ChatComposerControllerOptions) {
    const [activeSlashSuggestionIndex, setActiveSlashSuggestionIndex] = useState(0);
    const [isAttachmentPickerOpen, setIsAttachmentPickerOpen] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [slashSuggestionsDismissed, setSlashSuggestionsDismissed] = useState(false);
    const fileDragDepthRef = useRef(0);
    const textareaRef = useRef<HTMLTextAreaElement | undefined>(undefined);
    const slashOptionsRef = useRef<HTMLDivElement | null>(null);
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
    if (
        currentModel &&
        modelSelectOptions.every((option) => option.value !== currentModel)
    ) {
        modelSelectOptions.unshift({ value: currentModel, label: currentModel });
    }
    if (modelSelectOptions.length === 0) {
        modelSelectOptions.push({ value: "", label: "Default" });
    }
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
                textareaRef.current?.contains(target) ||
                slashOptionsRef.current?.contains(target)
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
                fileDragDepthRef.current = 0;
                setIsDraggingFiles(false);
            }
        };

        const listenerOptions = { capture: true };
        const unsubscribeDragOver = subscribeToGlobalEvent<globalThis.DragEvent>(
            "dragover",
            preventPageFileDrop,
            listenerOptions
        );
        const unsubscribeDrop = subscribeToGlobalEvent<globalThis.DragEvent>(
            "drop",
            preventPageFileDrop,
            listenerOptions
        );
        return () => {
            unsubscribeDragOver();
            unsubscribeDrop();
        };
    }, []);

    /**
     * Performs insert emoji.
     * @param emoji Emoji value.
     */
    const insertEmoji = (emoji: string) => {
        const textarea = textareaRef.current;
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
        requestAnimationFrame(() => textareaRef.current?.focus());
    };

    /** Shows a drop affordance while files are dragged over the composer. */
    const handleFileDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        fileDragDepthRef.current += 1;
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
        fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
        if (fileDragDepthRef.current === 0) {
            setIsDraggingFiles(false);
        }
    };

    /** Attaches files dropped directly onto the composer. */
    const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        fileDragDepthRef.current = 0;
        setIsDraggingFiles(false);
        if (canAttachFiles && event.dataTransfer.files.length > 0) {
            onAttachFiles(event.dataTransfer.files, "composer");
        }
    };

    /**
     * Attaches a file-picker selection while keeping the custom picker open.
     * @param files Files value.
     */
    const handleFilesSelected = (files: FileList | undefined) => {
        if (!canAttachFiles || !files || files.length === 0) {
            return;
        }
        onAttachFiles(files, "picker");
    };

    return {
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
    };
}
