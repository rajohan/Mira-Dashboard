import { Download, FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";

import { formatSize } from "../../../utils/format";
import { Modal } from "../../ui/Modal";
import { JsonPreview } from "../files/viewers/JsonPreview";
import { MarkdownPreview } from "../files/viewers/MarkdownPreview";
import {
    chatAttachmentPreviewUrl,
    chatImageDisplayUrl,
    type ChatPreviewItem,
    normalizeChatMimeType,
} from "./chatTypes";

/** Provides props for attachment preview modal. */
interface AttachmentPreviewModalProperties {
    previewItem: ChatPreviewItem | undefined;
    onClose: () => void;
}

interface AttachmentPreviewContentProperties {
    previewItem: ChatPreviewItem;
}

/** Renders the attachment kind inside the preview toolbar. */
function PreviewFileIcon({ kind }: { kind: ChatPreviewItem["kind"] }) {
    if (kind === "image") {
        return <ImageIcon className="size-5" />;
    }
    if (kind === "text") {
        return <FileText className="size-5" />;
    }
    return <Paperclip className="size-5" />;
}

/** Renders reusable attachment preview content without adding a dialog layer. */
export function AttachmentPreviewContent({
    previewItem,
}: AttachmentPreviewContentProperties) {
    const [remoteText, setRemoteText] = useState<string | undefined>(undefined);
    const [textPreviewError, setTextPreviewError] = useState<string | undefined>(
        undefined
    );
    const [isLoadingTextPreview, setIsLoadingTextPreview] = useState(false);

    useEffect(() => {
        setRemoteText(undefined);
        setTextPreviewError(undefined);
        setIsLoadingTextPreview(false);
        if (
            !previewItem.url ||
            previewItem.kind !== "text" ||
            previewItem.text !== undefined
        ) {
            return;
        }
        const previewUrl = chatAttachmentPreviewUrl(previewItem.url, "text");
        if (!previewUrl) {
            return;
        }

        const abortController = new AbortController();
        setIsLoadingTextPreview(true);
        void fetch(previewUrl, {
            headers: { Accept: "text/plain" },
            signal: abortController.signal,
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Text preview failed (${response.status})`);
                }
                return response.text();
            })
            .then((text) => {
                if (!abortController.signal.aborted) {
                    setRemoteText(text);
                }
            })
            .catch((error: unknown) => {
                if (!abortController.signal.aborted) {
                    setTextPreviewError(
                        error instanceof Error
                            ? error.message
                            : "Text preview could not be loaded"
                    );
                }
            })
            .finally(() => {
                if (!abortController.signal.aborted) {
                    setIsLoadingTextPreview(false);
                }
            });

        return () => abortController.abort();
    }, [previewItem]);

    const textPreview = previewItem.text ?? remoteText;
    const normalizedMimeType = normalizeChatMimeType(previewItem.mimeType || "");
    const imagePreviewUrl =
        previewItem.kind === "image" && previewItem.url
            ? chatImageDisplayUrl(previewItem.url, previewItem.mimeType || "")
            : undefined;
    const shouldRenderJson =
        normalizedMimeType === "application/json" ||
        previewItem.title.toLowerCase().endsWith(".json");
    const shouldRenderMarkdown =
        normalizedMimeType === "text/markdown" ||
        previewItem.title.toLowerCase().endsWith(".md");
    const isTextPreview = previewItem.kind === "text";

    return (
        <div className="space-y-3">
            <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-primary-700 bg-primary-900/55 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-700 text-accent-300">
                        <PreviewFileIcon kind={previewItem.kind} />
                    </div>
                    <div className="min-w-0">
                        <div className="text-[11px] font-medium tracking-wide text-primary-500 uppercase">
                            File type
                        </div>
                        <div className="text-sm break-all text-primary-100">
                            {previewItem.mimeType || "application/octet-stream"}
                        </div>
                        {typeof previewItem.sizeBytes === "number" ? (
                            <div className="mt-0.5 text-xs text-primary-400">
                                {formatSize(previewItem.sizeBytes)}
                            </div>
                        ) : undefined}
                    </div>
                </div>
                {previewItem.url ? (
                    <a
                        href={previewItem.url}
                        download={previewItem.title}
                        className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 self-stretch rounded-lg border border-primary-600 bg-primary-700 px-3 text-sm font-medium text-primary-100 transition hover:border-primary-500 hover:bg-primary-600 sm:self-center"
                    >
                        <Download className="size-4" />
                        Download file
                    </a>
                ) : undefined}
            </div>
            {imagePreviewUrl ? (
                <img
                    src={imagePreviewUrl}
                    alt={previewItem.title}
                    className="max-h-[70vh] w-full rounded-lg object-contain"
                />
            ) : isTextPreview && textPreview !== undefined && shouldRenderJson ? (
                <div className="max-h-[70vh] overflow-auto rounded-lg border border-primary-700 bg-primary-950">
                    <JsonPreview content={textPreview} />
                </div>
            ) : isTextPreview && textPreview !== undefined && shouldRenderMarkdown ? (
                <div className="max-h-[70vh] overflow-auto rounded-lg border border-primary-700 bg-primary-950">
                    <MarkdownPreview content={textPreview} renderImages={false} />
                </div>
            ) : isTextPreview && textPreview !== undefined ? (
                <pre className="max-h-[70vh] overflow-auto rounded-lg border border-primary-700 bg-primary-950 p-4 text-sm whitespace-pre-wrap text-primary-100">
                    {textPreview}
                </pre>
            ) : isTextPreview && isLoadingTextPreview ? (
                <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                    Loading preview…
                </div>
            ) : isTextPreview && textPreviewError ? (
                <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                    {textPreviewError}
                </div>
            ) : previewItem.url ? (
                <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-200">
                    Preview is not available for this file type yet. Use the download link
                    above to open it locally.
                </div>
            ) : (
                <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                    This historical attachment has no preview data available.
                </div>
            )}
        </div>
    );
}

/** Renders the attachment preview in its standalone modal. */
export function AttachmentPreviewModal({
    previewItem,
    onClose,
}: AttachmentPreviewModalProperties) {
    return (
        <Modal
            isOpen={Boolean(previewItem)}
            onClose={onClose}
            title={previewItem?.title || "Attachment preview"}
            size="3xl"
        >
            {previewItem ? (
                <AttachmentPreviewContent previewItem={previewItem} />
            ) : undefined}
        </Modal>
    );
}
