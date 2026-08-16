import { Download } from "lucide-react";
import { useEffect, useState } from "react";

import { buttonClassNames } from "../ui/buttonStyles.ts";
import { Icon } from "../ui/Icon.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { Modal } from "../ui/Modal.tsx";
import {
    chatAttachmentIcon,
    formatChatAttachmentSize,
} from "./chatAttachmentPresentation.ts";
import type { ChatDraftAttachment, ChatMessageAttachment } from "./chatTypes.ts";
/* eslint-disable jsx-a11y/media-has-caption -- Local user-selected audio has no authored caption track. */

const maximumTextPreviewBytes = 128 * 1024;
const maximumRemoteTextPreviewBytes = 1024 * 1024;
const safeRasterPreviewTypes: ReadonlySet<string> = new Set([
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
]);
const safeTextPreviewTypes: ReadonlySet<string> = new Set([
    "application/json",
    "application/ld+json",
    "text/csv",
    "text/markdown",
    "text/plain",
]);
const managedPreviewUrlPattern =
    /^\/api\/chat\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?disposition=preview$/u;
const managedDownloadUrlPattern =
    /^\/api\/chat\/media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\?disposition=download$/u;

type RemoteTextPreviewState =
    | Readonly<{ status: "idle" | "loading" }>
    | Readonly<{ message: string; status: "error" }>
    | Readonly<{ status: "ready"; text: string }>;

async function readBoundedTextResponse(
    response: Response,
    signal: AbortSignal
): Promise<string | undefined> {
    const declared = response.headers.get("content-length")?.trim();
    if (
        declared !== undefined &&
        /^\d+$/u.test(declared) &&
        Number(declared) > maximumRemoteTextPreviewBytes
    ) {
        return undefined;
    }
    if (response.body === null) return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
        while (true) {
            if (signal.aborted) return undefined;
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > maximumRemoteTextPreviewBytes) {
                await reader.cancel("Chat text preview exceeded its budget");
                return undefined;
            }
            text += decoder.decode(result.value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

export type ChatPreviewAttachment = Pick<
    ChatDraftAttachment | ChatMessageAttachment,
    "mediaType" | "name" | "sizeBytes"
> &
    Partial<Pick<ChatDraftAttachment, "file">> &
    Partial<Pick<ChatMessageAttachment, "downloadUrl" | "previewUrl" | "renderPolicy">>;

interface ChatAttachmentPreviewProps {
    readonly attachment?: ChatPreviewAttachment;
    readonly onClose: () => void;
}

function validatedManagedPreviewUrl(
    attachment: ChatPreviewAttachment | undefined
): string | undefined {
    const candidate = attachment?.previewUrl ?? attachment?.downloadUrl;
    return candidate !== undefined && managedPreviewUrlPattern.test(candidate)
        ? candidate
        : undefined;
}

function validatedManagedDownloadUrl(
    attachment: ChatPreviewAttachment | undefined
): string | undefined {
    const candidate = attachment?.downloadUrl;
    return candidate !== undefined && managedDownloadUrlPattern.test(candidate)
        ? candidate
        : undefined;
}

function initialRemoteTextPreview(
    attachment: ChatPreviewAttachment | undefined
): RemoteTextPreviewState {
    if (attachment?.file !== undefined || attachment?.renderPolicy !== "bounded-text") {
        return { status: "idle" };
    }
    return validatedManagedPreviewUrl(attachment) !== undefined &&
        safeTextPreviewTypes.has(attachment.mediaType)
        ? { status: "loading" }
        : {
              message: "This attachment cannot be previewed as text.",
              status: "error",
          };
}

/**
 * Renders an explicit, bounded attachment preview without auto-loading unsafe types.
 * @returns Managed attachment preview modal.
 */
export function ChatAttachmentPreview({
    attachment,
    onClose,
}: ChatAttachmentPreviewProps) {
    const [localUrl, setLocalUrl] = useState<string>();
    const [remoteTextPreview, setRemoteTextPreview] = useState<RemoteTextPreviewState>(
        () => initialRemoteTextPreview(attachment)
    );
    const [textPreview, setTextPreview] = useState<string>();

    useEffect(() => {
        if (attachment?.file === undefined || typeof URL.createObjectURL !== "function") {
            return;
        }
        let active = true;
        const nextUrl = URL.createObjectURL(attachment.file);
        queueMicrotask(() => {
            if (active) setLocalUrl(nextUrl);
        });
        return () => {
            active = false;
            URL.revokeObjectURL(nextUrl);
        };
    }, [attachment]);

    useEffect(() => {
        if (
            attachment?.file !== undefined ||
            attachment?.renderPolicy !== "bounded-text"
        ) {
            return;
        }
        const previewUrl = validatedManagedPreviewUrl(attachment);
        if (previewUrl === undefined || !safeTextPreviewTypes.has(attachment.mediaType)) {
            return;
        }
        const controller = new AbortController();
        void (async () => {
            try {
                const response = await fetch(previewUrl, {
                    credentials: "same-origin",
                    headers: { Accept: attachment.mediaType },
                    signal: controller.signal,
                });
                const mediaType =
                    response.headers
                        .get("content-type")
                        ?.split(";", 1)[0]
                        ?.trim()
                        .toLowerCase() ?? "";
                const text =
                    response.ok &&
                    mediaType === attachment.mediaType &&
                    safeTextPreviewTypes.has(mediaType)
                        ? await readBoundedTextResponse(response, controller.signal)
                        : undefined;
                if (controller.signal.aborted) return;
                setRemoteTextPreview(
                    text === undefined
                        ? {
                              message: "The text preview could not be loaded.",
                              status: "error",
                          }
                        : { status: "ready", text }
                );
            } catch {
                if (controller.signal.aborted) return;
                setRemoteTextPreview({
                    message: "The text preview could not be loaded.",
                    status: "error",
                });
            }
        })();
        return () => controller.abort();
    }, [attachment]);

    useEffect(() => {
        let active = true;
        if (
            attachment?.file === undefined ||
            !safeTextPreviewTypes.has(attachment.mediaType)
        ) {
            return;
        }
        const file = attachment.file;
        void (async () => {
            const text = await file.slice(0, maximumTextPreviewBytes).text();
            if (active) setTextPreview(text);
        })();
        return () => {
            active = false;
        };
    }, [attachment]);

    const managedRemotePreviewUrl = validatedManagedPreviewUrl(attachment);
    const managedRemoteDownloadUrl = validatedManagedDownloadUrl(attachment);
    const previewUrl = localUrl ?? managedRemotePreviewUrl;
    const imagePreviewAllowed =
        attachment !== undefined &&
        previewUrl !== undefined &&
        safeRasterPreviewTypes.has(attachment.mediaType) &&
        (attachment.file !== undefined || attachment.renderPolicy === "inline-image");
    const audioPreviewAllowed =
        attachment?.file !== undefined &&
        previewUrl !== undefined &&
        attachment.mediaType.startsWith("audio/");
    const downloadUrl = localUrl ?? managedRemoteDownloadUrl;

    return (
        <Modal
            onClose={onClose}
            open={attachment !== undefined}
            size="lg"
            title={attachment?.name ?? "Attachment preview"}
        >
            {attachment !== undefined && (
                <div className="min-w-0 space-y-4">
                    <div
                        className="border-primary-700 bg-primary-900 flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                        data-testid="attachment-preview-toolbar"
                    >
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="bg-primary-700 text-accent-300 flex size-10 shrink-0 items-center justify-center rounded-lg">
                                <Icon
                                    icon={chatAttachmentIcon(attachment.mediaType)}
                                    size="md"
                                    tone="inherit"
                                />
                            </span>
                            <div className="min-w-0">
                                <p className="text-primary-500 text-[11px] font-medium tracking-wide uppercase">
                                    File type
                                </p>
                                <p className="text-primary-100 text-sm break-all">
                                    {attachment.mediaType}
                                </p>
                                <p className="text-primary-400 mt-0.5 text-xs">
                                    {attachment.sizeBytes > 0
                                        ? formatChatAttachmentSize(attachment.sizeBytes)
                                        : "Size unavailable"}
                                </p>
                            </div>
                        </div>
                        {downloadUrl !== undefined && (
                            <a
                                className={buttonClassNames({
                                    className: "w-full shrink-0 justify-center sm:w-auto",
                                    size: "sm",
                                    variant: "secondary",
                                })}
                                download={attachment.name}
                                href={downloadUrl}
                            >
                                <Icon icon={Download} size="sm" tone="inherit" />
                                Download file
                            </a>
                        )}
                    </div>
                    {imagePreviewAllowed && (
                        <img
                            alt={`Preview of ${attachment.name}`}
                            className="border-primary-600 bg-primary-950 max-h-[min(60vh,36rem)] w-full rounded-lg border object-contain"
                            src={previewUrl}
                        />
                    )}
                    {audioPreviewAllowed && (
                        <audio
                            aria-label={`Preview of ${attachment.name}`}
                            className="w-full"
                            controls
                            src={previewUrl}
                        />
                    )}
                    {textPreview !== undefined && (
                        <pre className="border-primary-600 bg-primary-950 text-primary-200 max-h-[min(55vh,32rem)] overflow-auto rounded-lg border p-3 text-xs wrap-break-word whitespace-pre-wrap">
                            {textPreview}
                            {attachment.sizeBytes > maximumTextPreviewBytes
                                ? "\n\n[Preview shortened]"
                                : ""}
                        </pre>
                    )}
                    {remoteTextPreview.status === "loading" && (
                        <output className="text-primary-300 block py-10 text-center text-sm">
                            Loading text preview…
                        </output>
                    )}
                    {remoteTextPreview.status === "ready" &&
                        (attachment.mediaType === "text/markdown" ? (
                            <Markdown
                                className="border-primary-600 bg-primary-950 max-h-[min(55vh,32rem)] overflow-auto rounded-lg border p-4"
                                components={{
                                    a: ({ children }) => <span>{children}</span>,
                                    img: ({ alt }) => (
                                        <span role="note">
                                            [Image blocked{alt ? `: ${alt}` : ""}]
                                        </span>
                                    ),
                                }}
                                source={remoteTextPreview.text}
                            />
                        ) : (
                            <pre className="border-primary-600 bg-primary-950 text-primary-200 max-h-[min(55vh,32rem)] overflow-auto rounded-lg border p-3 text-xs wrap-break-word whitespace-pre-wrap">
                                {remoteTextPreview.text}
                            </pre>
                        ))}
                    {remoteTextPreview.status === "error" && (
                        <p className="text-sm text-red-300" role="alert">
                            {remoteTextPreview.message}
                        </p>
                    )}
                    {!imagePreviewAllowed &&
                        !audioPreviewAllowed &&
                        textPreview === undefined &&
                        (remoteTextPreview.status === "idle" ||
                            remoteTextPreview.status === "error") && (
                            <div className="border-primary-600 bg-primary-900 flex min-h-40 flex-col items-center justify-center rounded-lg border p-5 text-center">
                                <Icon
                                    icon={chatAttachmentIcon(attachment.mediaType)}
                                    size="xl"
                                    tone="default"
                                />
                                <p className="text-primary-100 mt-3 font-medium">
                                    Preview unavailable
                                </p>
                                <p className="text-primary-400 mt-1 max-w-md text-sm">
                                    This file type can be downloaded but cannot be safely
                                    shown in the Dashboard.
                                </p>
                            </div>
                        )}
                </div>
            )}
        </Modal>
    );
}
