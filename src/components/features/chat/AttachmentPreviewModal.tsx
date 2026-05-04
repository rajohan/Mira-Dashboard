import { formatSize } from "../../../utils/format";
import { Modal } from "../../ui/Modal";
import type { ChatPreviewItem } from "./chatTypes";

interface AttachmentPreviewModalProps {
    previewItem: ChatPreviewItem | null;
    onClose: () => void;
}

export function AttachmentPreviewModal({
    previewItem,
    onClose,
}: AttachmentPreviewModalProps) {
    return (
        <Modal
            isOpen={Boolean(previewItem)}
            onClose={onClose}
            title={previewItem?.title || "Attachment preview"}
            size="3xl"
        >
            {previewItem ? (
                <div className="space-y-3">
                    <div className="text-xs text-primary-400">
                        {previewItem.mimeType || "application/octet-stream"}
                        {previewItem.sizeBytes
                            ? ` · ${formatSize(previewItem.sizeBytes)}`
                            : ""}
                    </div>
                    {previewItem.kind === "image" && previewItem.url ? (
                        <img
                            src={previewItem.url}
                            alt={previewItem.title}
                            className="max-h-[70vh] w-full rounded-lg object-contain"
                        />
                    ) : previewItem.kind === "text" && previewItem.text ? (
                        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg border border-primary-700 bg-primary-950 p-4 text-sm text-primary-100">
                            {previewItem.text}
                        </pre>
                    ) : previewItem.url ? (
                        <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-200">
                            Preview is not available for this file type yet.
                            <a
                                href={previewItem.url}
                                download={previewItem.title}
                                className="ml-2 text-accent-300 underline hover:text-accent-200"
                            >
                                Download file
                            </a>
                        </div>
                    ) : (
                        <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                            This historical attachment has no preview data available.
                        </div>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}
