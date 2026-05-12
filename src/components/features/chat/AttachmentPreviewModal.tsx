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
                    <div className="text-primary-400 text-xs">
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
                        <pre className="border-primary-700 bg-primary-950 text-primary-100 max-h-[70vh] overflow-auto rounded-lg border p-4 text-sm whitespace-pre-wrap">
                            {previewItem.text}
                        </pre>
                    ) : previewItem.url ? (
                        <div className="border-primary-700 bg-primary-900/60 text-primary-200 rounded-lg border p-4 text-sm">
                            Preview is not available for this file type yet.
                            <a
                                href={previewItem.url}
                                download={previewItem.title}
                                className="text-accent-300 hover:text-accent-200 ml-2 underline"
                            >
                                Download file
                            </a>
                        </div>
                    ) : (
                        <div className="border-primary-700 bg-primary-900/60 text-primary-300 rounded-lg border p-4 text-sm">
                            This historical attachment has no preview data available.
                        </div>
                    )}
                </div>
            ) : null}
        </Modal>
    );
}
