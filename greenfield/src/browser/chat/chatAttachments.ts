import type { TRPCRequestOptions } from "@trpc/client";

import type {
    ChatAttachmentTicketPrepareInput,
    ChatAttachmentTicketPrepareOutput,
} from "../../contracts/chatMedia.ts";
import {
    chatAttachmentLimits,
    isVideoChatAttachment,
    normalizeChatAttachmentMimeType,
} from "../../contracts/chatMedia.ts";
import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";
import type { ChatDraftAttachment } from "./chatTypes.ts";

export interface ChatAttachmentPolicyResult {
    readonly files: readonly File[];
    readonly message?: string;
}

export interface ChatAttachmentTicketClient {
    readonly mutation: (
        name: "chat.prepareAttachmentTicket",
        input: ChatAttachmentTicketPrepareInput,
        options?: TRPCRequestOptions
    ) => Promise<ChatAttachmentTicketPrepareOutput>;
}

export interface ChatAttachmentUploadResult {
    readonly attachments: readonly ChatDraftAttachment[];
    readonly ticketId: string;
}

export type ChatAttachmentProgress = (
    attachmentId: string,
    progress: number,
    status: ChatDraftAttachment["status"]
) => void;

export const chatAttachmentUploadTimeoutMs = 60_000;

/**
 * Returns the exact MIME declaration sent to ticket preparation and raw PUT.
 * @param file Browser-selected attachment.
 * @returns Canonical MIME type or an empty unsupported marker.
 */
export function chatAttachmentMediaType(file: File): string {
    return normalizeChatAttachmentMimeType(file.name, file.type) ?? "";
}

/**
 * Applies the shared count, per-file, aggregate, and metadata budgets before upload.
 * @param files Complete proposed composer file set, including already selected files.
 * @returns Valid files or one aggregate operator-facing policy message.
 */
export function validateChatAttachmentFiles(
    files: readonly File[]
): ChatAttachmentPolicyResult {
    const failures: string[] = [];
    if (files.length > chatAttachmentLimits.maximumFiles) {
        failures.push(`Choose at most ${chatAttachmentLimits.maximumFiles} files.`);
    }
    let aggregateBytes = 0;
    for (const file of files) {
        aggregateBytes += file.size;
        if (file.size === 0) failures.push(`${file.name || "Unnamed file"} is empty.`);
        if (file.size > chatAttachmentLimits.maximumFileBytes) {
            failures.push(`${file.name || "Unnamed file"} exceeds 16 MiB.`);
        }
        if (
            file.name.length === 0 ||
            file.name.length > 255 ||
            !/\S/u.test(file.name) ||
            !hasNoUnicodeControlOrFormat(file.name)
        ) {
            failures.push("One attachment has an invalid file name.");
        }
        const mediaType = normalizeChatAttachmentMimeType(file.name, file.type);
        if (mediaType === undefined) {
            failures.push(
                isVideoChatAttachment(file.name, file.type)
                    ? `${file.name || "Unnamed file"} is a video. Video attachments are not supported.`
                    : `${file.name || "Unnamed file"} has an unsupported file type.`
            );
        }
    }
    if (aggregateBytes > chatAttachmentLimits.maximumAggregateRawBytes) {
        failures.push("The selected attachments exceed the 16 MiB total limit.");
    }
    return failures.length === 0
        ? { files }
        : { files: [], message: [...new Set(failures)].join(" ") };
}

/**
 * Creates locally stable rows after aggregate policy validation.
 * @param files Validated browser files.
 * @returns Stable composer attachment rows.
 */
export function createChatDraftAttachments(
    files: readonly File[]
): readonly ChatDraftAttachment[] {
    return files.map((file) => {
        const mediaType = normalizeChatAttachmentMimeType(file.name, file.type);
        if (mediaType === undefined) {
            throw new RangeError(
                `${file.name || "Unnamed file"} has an unsupported file type.`
            );
        }
        return {
            file,
            id: crypto.randomUUID(),
            mediaType,
            name: file.name,
            progress: 0,
            sizeBytes: file.size,
            status: "ready",
        };
    });
}

interface UploadRequest {
    readonly abort: () => void;
    readonly addEventListener: XMLHttpRequest["addEventListener"];
    readonly open: XMLHttpRequest["open"];
    readonly send: XMLHttpRequest["send"];
    readonly setRequestHeader: XMLHttpRequest["setRequestHeader"];
    readonly status: number;
    timeout: number;
    readonly upload: Pick<XMLHttpRequestUpload, "addEventListener">;
    withCredentials: boolean;
}

export type ChatUploadRequestFactory = () => UploadRequest;

function browserUploadRequest(): UploadRequest {
    return new XMLHttpRequest();
}

function uploadAttachment(
    attachment: ChatDraftAttachment,
    uploadUrl: string,
    signal: AbortSignal,
    onProgress: ChatAttachmentProgress,
    requestFactory: ChatUploadRequestFactory
): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Attachment upload was aborted", "AbortError"));
            return;
        }
        const request = requestFactory();
        let settled = false;
        const abort = () => request.abort();
        const finish = (result: "resolve" | "reject", error?: Error): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", abort);
            if (result === "resolve") resolve();
            else reject(error ?? new Error("Attachment upload failed"));
        };
        signal.addEventListener("abort", abort, { once: true });
        request.upload.addEventListener("progress", (event) => {
            if (settled) return;
            const total = event.lengthComputable ? event.total : attachment.sizeBytes;
            const progress =
                total === 0 ? 0 : Math.min(99, Math.round((event.loaded / total) * 100));
            onProgress(attachment.id, progress, "uploading");
        });
        request.addEventListener("load", () => {
            if (request.status >= 200 && request.status < 300) {
                onProgress(attachment.id, 100, "ready");
                finish("resolve");
                return;
            }
            finish("reject", new Error("Attachment upload was rejected"));
        });
        request.addEventListener("error", () => {
            finish("reject", new Error("Attachment upload failed"));
        });
        request.addEventListener("abort", () => {
            finish(
                "reject",
                new DOMException("Attachment upload was aborted", "AbortError")
            );
        });
        request.addEventListener("timeout", () => {
            finish("reject", new Error("Attachment upload timed out"));
        });
        request.open("PUT", uploadUrl, true);
        request.withCredentials = true;
        request.timeout = chatAttachmentUploadTimeoutMs;
        request.setRequestHeader("Content-Type", attachment.mediaType);
        onProgress(attachment.id, 0, "uploading");
        request.send(attachment.file);
    });
}

/**
 * Reserves one one-shot ticket and uploads every exact file slot with progress.
 * The returned ticket id is the only media reference carried by `chat.send`.
 * @param client Ticket mutation client.
 * @param sessionKey Exact provider session key.
 * @param attachments Validated attachment rows.
 * @param idempotencyKey Send-owned replay key.
 * @param signal Auth-generation-scoped cancellation signal.
 * @param onProgress Upload progress observer.
 * @param requestFactory Testable same-origin request factory.
 * @returns Prepared ticket identity and uploaded attachment rows.
 */
export async function prepareAndUploadChatAttachments(
    client: ChatAttachmentTicketClient,
    sessionKey: string,
    attachments: readonly ChatDraftAttachment[],
    idempotencyKey: string,
    signal: AbortSignal,
    onProgress: ChatAttachmentProgress,
    requestFactory: ChatUploadRequestFactory = browserUploadRequest
): Promise<ChatAttachmentUploadResult> {
    const policy = validateChatAttachmentFiles(
        attachments.map((attachment) => attachment.file)
    );
    if (policy.message !== undefined) throw new RangeError(policy.message);
    const ticket = await client.mutation(
        "chat.prepareAttachmentTicket",
        {
            files: attachments.map((attachment) => ({
                fileName: attachment.name,
                mimeType: attachment.mediaType,
                sizeBytes: attachment.sizeBytes,
            })),
            idempotencyKey,
            sessionKey,
        },
        { signal }
    );
    if (
        ticket.uploads.length !== attachments.length ||
        ticket.expiresAtMs <= Date.now()
    ) {
        throw new Error("Attachment ticket is unavailable");
    }
    const uploadGroup = new AbortController();
    const abortUploadGroup = () => uploadGroup.abort(signal.reason);
    if (signal.aborted) abortUploadGroup();
    else signal.addEventListener("abort", abortUploadGroup, { once: true });
    try {
        await Promise.all(
            attachments.map((attachment, index) => {
                const upload = ticket.uploads[index];
                if (upload === undefined) {
                    uploadGroup.abort();
                    throw new Error("Attachment upload slot is missing");
                }
                return uploadAttachment(
                    attachment,
                    upload.uploadUrl,
                    uploadGroup.signal,
                    onProgress,
                    requestFactory
                ).catch((error: unknown) => {
                    uploadGroup.abort();
                    throw error;
                });
            })
        );
    } finally {
        signal.removeEventListener("abort", abortUploadGroup);
    }
    return { attachments, ticketId: ticket.ticketId };
}
