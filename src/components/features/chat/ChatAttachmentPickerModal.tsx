import { FileUp, FolderOpen } from "lucide-react";
import { type DragEvent, useState } from "react";

import { formatSize } from "../../../utils/format";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "./chatUtilities";

/** Returns whether a browser drag contains files from the operating system. */
export function hasFilesInDataTransfer(dataTransfer: DataTransfer): boolean {
    return [...dataTransfer.types].includes("Files");
}

interface ChatAttachmentPickerModalProperties {
    attachmentCount: number;
    isDisabled?: boolean;
    isOpen: boolean;
    onChooseFiles: () => void;
    onClose: () => void;
    onFilesSelected: (files: FileList) => void;
}

/** Renders the custom file selection and drop experience for chat attachments. */
export function ChatAttachmentPickerModal({
    attachmentCount,
    isDisabled = false,
    isOpen,
    onChooseFiles,
    onClose,
    onFilesSelected,
}: ChatAttachmentPickerModalProperties) {
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const remainingSlots = Math.max(0, MAX_ATTACHMENTS - attachmentCount);

    const handleDrag = (event: DragEvent<HTMLDivElement>) => {
        if (!hasFilesInDataTransfer(event.dataTransfer)) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setIsDraggingFiles(true);
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
        if (isDisabled || remainingSlots === 0 || event.dataTransfer.files.length === 0) {
            return;
        }
        onFilesSelected(event.dataTransfer.files);
    };

    return (
        <Modal isOpen={isOpen} onClose={onClose} title="Attach files" size="lg">
            <div className="min-w-0 space-y-4">
                <div
                    data-testid="chat-attachment-drop-zone"
                    onDragEnter={handleDrag}
                    onDragOver={handleDrag}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={[
                        "flex min-h-56 min-w-0 flex-col items-center justify-center rounded-xl border-2 border-dashed px-5 py-8 text-center transition-colors",
                        isDraggingFiles
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
                        Images, documents and audio are supported. Videos are skipped.
                    </p>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onChooseFiles}
                        disabled={isDisabled || remainingSlots === 0}
                        className="mt-5"
                    >
                        <FolderOpen className="size-4" />
                        Choose files
                    </Button>
                </div>
                <div className="flex min-w-0 flex-col gap-1 text-xs text-primary-400 sm:flex-row sm:items-center sm:justify-between">
                    <span>
                        {remainingSlots} of {MAX_ATTACHMENTS} attachment slots available
                    </span>
                    <span>Maximum {formatSize(MAX_ATTACHMENT_BYTES)} per file</span>
                </div>
            </div>
        </Modal>
    );
}
