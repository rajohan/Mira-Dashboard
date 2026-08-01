import { Download, FileText, Image as ImageIcon, Paperclip } from "lucide-react";
import { useEffect, useState } from "react";

import { messageFromError } from "../../../lib/errorMessage";
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

interface AttachmentPreviewBodyProperties {
    imagePreviewUrl: string | undefined;
    isLoadingTextPreview: boolean;
    isTextPreview: boolean;
    previewItem: ChatPreviewItem;
    shouldRenderJson: boolean;
    shouldRenderMarkdown: boolean;
    textPreview: string | undefined;
    textPreviewError: string | undefined;
}

/**
 * Renders the attachment kind inside the preview toolbar.
 * @returns Rendered the attachment kind inside the preview toolbar.
 */
function PreviewFileIcon({ kind }: { kind: ChatPreviewItem["kind"] }) {
    if (kind === "image") {
        return <ImageIcon className="size-5" />;
    }
    if (kind === "text") {
        return <FileText className="size-5" />;
    }
    return <Paperclip className="size-5" />;
}

/**
 * Renders the best available preview for one attachment.
 *
 * @returns Attachment preview content.
 */
function AttachmentPreviewBody({
    imagePreviewUrl,
    isLoadingTextPreview,
    isTextPreview,
    previewItem,
    shouldRenderJson,
    shouldRenderMarkdown,
    textPreview,
    textPreviewError,
}: AttachmentPreviewBodyProperties) {
    if (imagePreviewUrl) {
        return (
            <img
                src={imagePreviewUrl}
                alt={previewItem.title}
                className="max-h-full w-full rounded-lg object-contain"
            />
        );
    }
    if (isTextPreview && textPreview !== undefined) {
        if (shouldRenderJson) {
            return (
                <div className="rounded-lg border border-primary-700 bg-primary-950">
                    <JsonPreview content={textPreview} scrollOwner="parent" />
                </div>
            );
        }
        if (shouldRenderMarkdown) {
            return (
                <div className="rounded-lg border border-primary-700 bg-primary-950">
                    <MarkdownPreview
                        content={textPreview}
                        renderImages={false}
                        scrollOwner="parent"
                    />
                </div>
            );
        }
        return (
            <pre className="rounded-lg border border-primary-700 bg-primary-950 p-4 text-sm whitespace-pre-wrap text-primary-100">
                {textPreview}
            </pre>
        );
    }
    if (isTextPreview && isLoadingTextPreview) {
        return (
            <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                Loading preview…
            </div>
        );
    }
    if (isTextPreview && textPreviewError) {
        return (
            <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
                {textPreviewError}
            </div>
        );
    }
    if (previewItem.url) {
        return (
            <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-200">
                Preview is not available for this file type yet. Use the download link
                above to open it locally.
            </div>
        );
    }
    return (
        <div className="rounded-lg border border-primary-700 bg-primary-900/60 p-4 text-sm text-primary-300">
            This historical attachment has no preview data available.
        </div>
    );
}

/**
 * Renders reusable attachment preview content without adding a dialog layer.
 * @returns Rendered reusable attachment preview content without adding a dialog layer.
 */
export function AttachmentPreviewContent({
    previewItem,
}: AttachmentPreviewContentProperties) {
    const remoteTextPreviewUrl =
        previewItem.url && previewItem.kind === "text" && previewItem.text === undefined
            ? chatAttachmentPreviewUrl(previewItem.url, "text")
            : undefined;
    const [remoteText, setRemoteText] = useState<string | undefined>();
    const [textPreviewError, setTextPreviewError] = useState<string | undefined>();
    const [isLoadingTextPreview, setIsLoadingTextPreview] = useState(
        () => remoteTextPreviewUrl !== undefined
    );

    useEffect(() => {
        if (!remoteTextPreviewUrl) {
            return;
        }

        const abortController = new AbortController();
        void (async () => {
            try {
                const response = await fetch(remoteTextPreviewUrl, {
                    headers: { Accept: "text/plain" },
                    signal: abortController.signal,
                });
                if (!response.ok) {
                    throw new Error(`Text preview failed (${response.status})`);
                }
                const text = await response.text();
                if (!abortController.signal.aborted) {
                    setRemoteText(text);
                }
            } catch (error) {
                if (!abortController.signal.aborted) {
                    setTextPreviewError(
                        messageFromError(error, "Text preview could not be loaded")
                    );
                }
            } finally {
                if (!abortController.signal.aborted) {
                    setIsLoadingTextPreview(false);
                }
            }
        })();

        return () => abortController.abort();
    }, [remoteTextPreviewUrl]);

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
        <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex min-w-0 shrink-0 flex-col gap-3 rounded-lg border border-primary-700 bg-primary-900/55 p-3 sm:flex-row sm:items-center sm:justify-between">
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
            <div
                className="min-h-0 flex-1 overflow-auto overscroll-contain"
                data-attachment-preview-scroll
            >
                <AttachmentPreviewBody
                    imagePreviewUrl={imagePreviewUrl}
                    isLoadingTextPreview={isLoadingTextPreview}
                    isTextPreview={isTextPreview}
                    previewItem={previewItem}
                    shouldRenderJson={shouldRenderJson}
                    shouldRenderMarkdown={shouldRenderMarkdown}
                    textPreview={textPreview}
                    textPreviewError={textPreviewError}
                />
            </div>
        </div>
    );
}

/**
 * Renders the attachment preview in its standalone modal.
 * @returns Rendered the attachment preview in its standalone modal.
 */
export function AttachmentPreviewModal({
    previewItem,
    onClose,
}: AttachmentPreviewModalProperties) {
    return (
        <Modal
            isOpen={Boolean(previewItem)}
            onClose={onClose}
            scrollOwner="content"
            title={previewItem?.title || "Attachment preview"}
            size="3xl"
        >
            {previewItem ? (
                <AttachmentPreviewContent
                    key={
                        previewItem.url ||
                        `${previewItem.kind}:${previewItem.title}:${previewItem.sizeBytes ?? ""}`
                    }
                    previewItem={previewItem}
                />
            ) : undefined}
        </Modal>
    );
}
