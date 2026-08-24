import { CircleAlert, CircleCheck, Paperclip, Upload, X } from "lucide-react";
import { type DragEvent, useState } from "react";

import { chatAttachmentLimits } from "../../contracts/chatMedia.ts";
import { cn } from "../lib/classNames.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Modal } from "../ui/Modal.tsx";
import {
    chatAttachmentIcon,
    chatAttachmentStatusLabel,
    chatAttachmentTypeLabel,
    formatChatAttachmentSize,
} from "./chatAttachmentPresentation.ts";
import type { ChatDraftAttachment } from "./chatTypes.ts";

interface ChatAttachmentPickerProps {
    readonly attachments: readonly ChatDraftAttachment[];
    readonly disabled?: boolean;
    readonly error?: string;
    readonly onChooseFiles: () => void;
    readonly onClose: () => void;
    readonly onFilesSelected: (files: FileList) => void;
    readonly onPreview: (attachmentId: string) => void;
    readonly onRemove: (attachmentId: string) => void;
    readonly open: boolean;
}

function attachmentStatusClass(status: ChatDraftAttachment["status"]): string {
    if (status === "error") return "text-red-300";
    if (status === "ready") return "text-emerald-300";
    return "text-primary-300";
}

function attachmentStatusIcon(status: ChatDraftAttachment["status"]) {
    if (status === "error") return CircleAlert;
    if (status === "ready") return CircleCheck;
    return Upload;
}

interface AttachmentRowProps {
    readonly attachment: ChatDraftAttachment;
    readonly compact?: boolean;
    readonly onPreview: (attachmentId: string) => void;
    readonly onRemove: (attachmentId: string) => void;
}

/**
 * Renders one readable prepared-file row used by the composer and picker.
 * @returns Compact attachment lifecycle row.
 */
export function ChatAttachmentRow({
    attachment,
    compact = false,
    onPreview,
    onRemove,
}: AttachmentRowProps) {
    const pending =
        attachment.status === "preparing" || attachment.status === "uploading";
    const statusTone = attachment.status === "error" ? "danger" : "inherit";

    if (compact) {
        const secondaryLabel =
            attachment.status === "ready"
                ? formatChatAttachmentSize(attachment.sizeBytes)
                : (attachment.error ??
                  `${chatAttachmentStatusLabel(attachment)} · ${formatChatAttachmentSize(attachment.sizeBytes)}`);

        return (
            <li
                className="border-primary-700 bg-primary-800 hover:border-primary-500 hover:bg-primary-700 relative flex min-h-12 w-full max-w-sm flex-[1_1_18rem] items-center gap-1 rounded-lg border p-1 text-xs transition-colors"
                data-compact="true"
            >
                <button
                    aria-label={`Preview ${attachment.name}`}
                    className="focus-visible:ring-accent-400 flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left outline-none focus-visible:ring-2"
                    onClick={() => onPreview(attachment.id)}
                    type="button"
                >
                    <span className="bg-primary-700 flex size-8 shrink-0 items-center justify-center rounded-md">
                        <Icon icon={chatAttachmentIcon(attachment.mediaType)} size="sm" />
                    </span>
                    <span className="min-w-0">
                        <span className="text-primary-100 block truncate text-xs font-medium">
                            {attachment.name}
                        </span>
                        <span
                            className={cn(
                                "text-primary-400 mt-0.5 block truncate text-[0.6875rem]",
                                attachment.status === "error" && "text-red-300"
                            )}
                        >
                            {secondaryLabel}
                        </span>
                    </span>
                </button>
                <IconOnlyButton
                    icon={X}
                    label={`Remove ${attachment.name}`}
                    onClick={() => onRemove(attachment.id)}
                    size="sm"
                    variant="ghost"
                />
                {pending && (
                    <span className="absolute inset-x-1 bottom-0 flex h-0.5">
                        <progress
                            aria-label={`Upload progress for ${attachment.name}`}
                            className="accent-accent-400 size-full"
                            max={100}
                            value={attachment.progress}
                        />
                    </span>
                )}
            </li>
        );
    }

    return (
        <li className="border-primary-600 bg-primary-900 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg border p-2.5">
            <button
                aria-label={`Preview ${attachment.name}`}
                className="hover:bg-primary-800 focus-visible:ring-accent-400 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md p-1 text-left transition-colors outline-none focus-visible:ring-2"
                onClick={() => onPreview(attachment.id)}
                type="button"
            >
                <span className="bg-primary-700 rounded-md p-1.5">
                    <Icon icon={chatAttachmentIcon(attachment.mediaType)} size="sm" />
                </span>
                <span className="min-w-0">
                    <span className="text-primary-100 block truncate text-sm font-medium">
                        {attachment.name}
                    </span>
                    <span className="text-primary-400 mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
                        <span className="truncate">
                            {chatAttachmentTypeLabel(attachment.mediaType)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">
                            {formatChatAttachmentSize(attachment.sizeBytes)}
                        </span>
                    </span>
                    <span
                        className={cn(
                            "mt-1 flex items-center gap-1 text-xs",
                            attachmentStatusClass(attachment.status)
                        )}
                    >
                        <Icon
                            className={cn(
                                pending && "animate-pulse motion-reduce:animate-none"
                            )}
                            icon={attachmentStatusIcon(attachment.status)}
                            size="sm"
                            tone={statusTone}
                        />
                        {chatAttachmentStatusLabel(attachment)}
                    </span>
                    {pending && (
                        <progress
                            aria-label={`Upload progress for ${attachment.name}`}
                            className="accent-accent-400 mt-1 h-1.5 w-full"
                            max={100}
                            value={attachment.progress}
                        />
                    )}
                    {attachment.error !== undefined && (
                        <span className="mt-1 block text-xs text-red-300">
                            {attachment.error}
                        </span>
                    )}
                </span>
            </button>
            <IconOnlyButton
                icon={X}
                label={`Remove ${attachment.name}`}
                onClick={() => onRemove(attachment.id)}
                size="sm"
                variant="ghost"
            />
        </li>
    );
}

/**
 * Renders the mobile-safe attachment picker and selected-file inventory.
 * @returns Managed picker modal with a drop zone and bounded file rows.
 */
export function ChatAttachmentPicker({
    attachments,
    disabled = false,
    error,
    onChooseFiles,
    onClose,
    onFilesSelected,
    onPreview,
    onRemove,
    open,
}: ChatAttachmentPickerProps) {
    const [dragging, setDragging] = useState(false);
    const remaining = Math.max(0, chatAttachmentLimits.maximumFiles - attachments.length);

    function handleDrop(event: DragEvent<HTMLButtonElement>): void {
        event.preventDefault();
        setDragging(false);
        if (disabled || event.dataTransfer.files.length === 0) return;
        onFilesSelected(event.dataTransfer.files);
    }

    return (
        <Modal
            description={`Up to ${chatAttachmentLimits.maximumFiles} files and 16 MiB total. Video is not supported.`}
            onClose={onClose}
            open={open}
            size="lg"
            title="Attach files"
        >
            <div className="min-w-0 space-y-4">
                <button
                    className={cn(
                        "border-primary-500 bg-primary-950 hover:border-accent-400 focus-visible:ring-accent-400 flex min-h-32 w-full min-w-0 flex-col items-center justify-center rounded-xl border border-dashed p-4 text-center transition-colors outline-none focus-visible:ring-2",
                        dragging && "border-accent-400 bg-primary-900"
                    )}
                    disabled={disabled || remaining === 0}
                    onClick={onChooseFiles}
                    onDragEnter={(event) => {
                        event.preventDefault();
                        if (!disabled && remaining > 0) setDragging(true);
                    }}
                    onDragLeave={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                            setDragging(false);
                        }
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={handleDrop}
                    type="button"
                >
                    <span className="bg-primary-700 rounded-full p-2.5">
                        <Icon icon={Paperclip} size="lg" tone="accent" />
                    </span>
                    <span className="text-primary-100 mt-3 font-medium">
                        Drop files here or choose files
                    </span>
                    <span className="text-primary-400 mt-1 text-sm">
                        {remaining} {remaining === 1 ? "slot" : "slots"} remaining
                    </span>
                </button>

                {error !== undefined && (
                    <p className="text-sm text-red-300" role="alert">
                        {error}
                    </p>
                )}

                {attachments.length > 0 && (
                    <section aria-labelledby="selected-attachments-heading">
                        <div className="mb-2 flex min-w-0 items-center justify-between gap-3">
                            <p
                                className="text-primary-200 min-w-0 font-medium"
                                id="selected-attachments-heading"
                            >
                                Selected files
                            </p>
                            <span className="text-primary-400 shrink-0 text-xs">
                                {attachments.length}/{chatAttachmentLimits.maximumFiles}
                            </span>
                        </div>
                        <ul className="max-h-[min(42vh,22rem)] space-y-2 overflow-y-auto pr-1">
                            {attachments.map((attachment) => (
                                <ChatAttachmentRow
                                    attachment={attachment}
                                    key={attachment.id}
                                    onPreview={onPreview}
                                    onRemove={onRemove}
                                />
                            ))}
                        </ul>
                    </section>
                )}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                        className="w-full justify-center sm:w-auto"
                        onClick={onClose}
                        variant="secondary"
                    >
                        Done
                    </Button>
                    <Button
                        className="w-full justify-center sm:w-auto"
                        disabled={disabled || remaining === 0}
                        onClick={onChooseFiles}
                    >
                        <Icon icon={Paperclip} size="sm" tone="inherit" />
                        Choose files
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
