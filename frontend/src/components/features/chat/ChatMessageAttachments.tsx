import { FileText, Image as ImageIcon, Paperclip } from "lucide-react";

import { formatSize } from "../../../utils/format";
import { previewFromAttachment } from "./chatAttachmentUtilities";
import type { ChatAttachmentDisplay, ChatPreviewItem } from "./chatTypes";

/**
 * Renders the attachment icon UI.
 * @returns Rendered the attachment icon UI.
 */
export function AttachmentIcon({ attachment }: { attachment: ChatAttachmentDisplay }) {
    if (attachment.kind === "image") {
        return <ImageIcon className="size-4" />;
    }

    if (attachment.kind === "text") {
        return <FileText className="size-4" />;
    }

    return <Paperclip className="size-4" />;
}

/**
 * Renders the attachment list UI.
 * @returns Rendered the attachment list UI.
 */
export function AttachmentList({
    attachments,
    onPreview,
}: {
    attachments: ChatAttachmentDisplay[];
    onPreview: (preview: ChatPreviewItem) => void;
}) {
    if (attachments.length === 0) {
        return;
    }

    return (
        <div className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
            {attachments.map((attachment) => {
                const preview = previewFromAttachment(attachment);
                const content = (
                    <>
                        <AttachmentIcon attachment={attachment} />
                        <span className="truncate">{attachment.fileName}</span>
                        {attachment.sizeBytes ? (
                            <span className="shrink-0 text-primary-400">
                                {formatSize(attachment.sizeBytes)}
                            </span>
                        ) : undefined}
                    </>
                );

                if (!preview) {
                    return (
                        <div
                            key={attachment.id}
                            className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-xs text-primary-100"
                            title={attachment.mimeType}
                        >
                            {content}
                        </div>
                    );
                }

                return (
                    <button
                        key={attachment.id}
                        type="button"
                        onClick={() => onPreview(preview)}
                        className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-primary-600 bg-primary-900/60 px-2 py-1 text-left text-xs text-primary-100 hover:border-primary-500 hover:bg-primary-800"
                        title={attachment.mimeType}
                    >
                        {content}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * Renders the delete message button UI.
 * @returns Rendered the delete message button UI.
 */
