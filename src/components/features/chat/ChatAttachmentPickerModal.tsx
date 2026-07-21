import {
    ArrowLeft,
    FileText,
    FileUp,
    FolderOpen,
    Image as ImageIcon,
    Paperclip,
    X,
} from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";

import { formatSize } from "../../../utils/format";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { AttachmentPreviewContent } from "./AttachmentPreviewModal";
import type { ChatPreviewItem, ChatSendAttachment } from "./chatTypes";
import {
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    previewFromSendAttachment,
} from "./chatUtilities";

/** Returns whether a browser drag contains files from the operating system. */
export function hasFilesInDataTransfer(dataTransfer: DataTransfer): boolean {
    return [...dataTransfer.types].includes("Files");
}

interface ChatAttachmentPickerModalProperties {
    attachments: ChatSendAttachment[];
    error?: string;
    isDisabled?: boolean;
    isOpen: boolean;
    onChooseFiles: () => void;
    onClose: () => void;
    onFilesSelected: (files: FileList) => void;
    onRemoveAttachment: (attachmentId: string) => void;
}

/** Renders an icon or thumbnail for an attachment waiting to be sent. */
function PendingAttachmentVisual({ attachment }: { attachment: ChatSendAttachment }) {
    if (attachment.kind === "image" && attachment.dataUrl) {
        return (
            <img
                src={attachment.dataUrl}
                alt=""
                className="size-10 shrink-0 rounded-lg object-cover"
            />
        );
    }
    let Icon = Paperclip;
    if (attachment.kind === "text") {
        Icon = FileText;
    } else if (attachment.kind === "image") {
        Icon = ImageIcon;
    }
    return (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-700 text-accent-300">
            <Icon className="size-5" />
        </span>
    );
}

/** Renders the custom file selection and drop experience for chat attachments. */
export function ChatAttachmentPickerModal({
    attachments,
    error,
    isDisabled = false,
    isOpen,
    onChooseFiles,
    onClose,
    onFilesSelected,
    onRemoveAttachment,
}: ChatAttachmentPickerModalProperties) {
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [previewItem, setPreviewItem] = useState<ChatPreviewItem | undefined>(
        undefined
    );
    const dropZoneReference = useRef<HTMLDivElement | null>(null);
    const remainingSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    const canAcceptFiles = !isDisabled && remainingSlots > 0;

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const preventFileDropOutsideZone = (event: globalThis.DragEvent) => {
            if (
                !event.dataTransfer ||
                !hasFilesInDataTransfer(event.dataTransfer) ||
                (event.target instanceof Node &&
                    dropZoneReference.current?.contains(event.target))
            ) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "none";
            if (event.type === "drop") {
                setIsDraggingFiles(false);
            }
        };

        const listenerOptions = { capture: true };
        addEventListener("dragenter", preventFileDropOutsideZone, listenerOptions);
        addEventListener("dragover", preventFileDropOutsideZone, listenerOptions);
        addEventListener("drop", preventFileDropOutsideZone, listenerOptions);
        return () => {
            removeEventListener("dragenter", preventFileDropOutsideZone, listenerOptions);
            removeEventListener("dragover", preventFileDropOutsideZone, listenerOptions);
            removeEventListener("drop", preventFileDropOutsideZone, listenerOptions);
        };
    }, [isOpen]);

    const handleClose = () => {
        setIsDraggingFiles(false);
        setPreviewItem(undefined);
        onClose();
    };

    const handleDrag = (event: DragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = canAcceptFiles ? "copy" : "none";
        setIsDraggingFiles(canAcceptFiles);
    };

    const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
            return;
        }
        setIsDraggingFiles(false);
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        setIsDraggingFiles(false);
        if (!canAcceptFiles || event.dataTransfer.files.length === 0) {
            return;
        }
        onFilesSelected(event.dataTransfer.files);
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleClose}
            title={previewItem?.title || "Attach files"}
            size={previewItem ? "3xl" : "lg"}
        >
            {previewItem ? (
                <div className="min-w-0 space-y-3">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setPreviewItem(undefined)}
                        className="-ml-2"
                    >
                        <ArrowLeft className="size-4" />
                        Back to attachments
                    </Button>
                    <AttachmentPreviewContent previewItem={previewItem} />
                </div>
            ) : (
                <div className="min-w-0 space-y-4">
                    {error ? (
                        <div role="alert">
                            <Alert variant="error" className="min-w-0 text-sm">
                                <span className="wrap-break-word">{error}</span>
                            </Alert>
                        </div>
                    ) : undefined}
                    {attachments.length > 0 ? (
                        <section aria-labelledby="selected-chat-attachments-heading">
                            <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
                                <h3
                                    id="selected-chat-attachments-heading"
                                    className="text-sm font-medium text-primary-100"
                                >
                                    Selected files
                                </h3>
                                <span className="shrink-0 text-xs text-primary-400">
                                    {attachments.length} of {MAX_ATTACHMENTS}
                                </span>
                            </div>
                            <div className="max-h-56 space-y-2 overflow-y-auto overscroll-contain pr-1">
                                {attachments.map((attachment) => (
                                    <div
                                        key={attachment.id}
                                        className="flex min-w-0 items-center gap-2 rounded-xl border border-primary-700 bg-primary-900/55 p-2"
                                    >
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setPreviewItem(
                                                    previewFromSendAttachment(attachment)
                                                )
                                            }
                                            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:ring-2 focus:ring-accent-500 focus:outline-none"
                                            aria-label={`Preview ${attachment.fileName}`}
                                        >
                                            <PendingAttachmentVisual
                                                attachment={attachment}
                                            />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm text-primary-100">
                                                    {attachment.fileName}
                                                </span>
                                                <span className="block truncate text-xs text-primary-400">
                                                    {attachment.mimeType ||
                                                        "Unknown type"}{" "}
                                                    · {formatSize(attachment.sizeBytes)}
                                                </span>
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onRemoveAttachment(attachment.id)
                                            }
                                            className="shrink-0 rounded-lg p-2 text-primary-400 transition hover:bg-primary-700 hover:text-primary-100 focus:ring-2 focus:ring-accent-500 focus:outline-none"
                                            aria-label={`Remove ${attachment.fileName}`}
                                        >
                                            <X className="size-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    ) : undefined}
                    <div
                        ref={dropZoneReference}
                        data-testid="chat-attachment-drop-zone"
                        onDragEnter={handleDrag}
                        onDragOver={handleDrag}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={[
                            "flex min-h-56 min-w-0 flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors",
                            isDraggingFiles && canAcceptFiles
                                ? "border-accent-400 bg-accent-500/10"
                                : "border-primary-600 bg-primary-900/45",
                        ].join(" ")}
                    >
                        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary-700 text-accent-300">
                            <FileUp className="size-6" />
                        </div>
                        <p className="text-base font-medium text-primary-100">
                            Drop files here
                        </p>
                        <p className="mt-1 max-w-sm text-sm wrap-break-word text-primary-400">
                            Images, audio, PDFs, text, ZIP and Office documents are
                            supported.
                        </p>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={onChooseFiles}
                            disabled={!canAcceptFiles}
                            className="mt-5"
                        >
                            <FolderOpen className="size-4" />
                            Choose files
                        </Button>
                    </div>
                    <div className="flex min-w-0 flex-col gap-1 text-xs text-primary-400 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {remainingSlots} of {MAX_ATTACHMENTS} attachment slots
                            available
                        </span>
                        <span>Maximum {formatSize(MAX_ATTACHMENT_BYTES)} per file</span>
                    </div>
                </div>
            )}
        </Modal>
    );
}
