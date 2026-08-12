import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import { utf8ByteLength } from "../shared/encoding.ts";
import {
    boundedControlSafeTextSchema,
    hasUniqueArrayItems,
    hasNoUnicodeControlOrFormat,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { gatewaySessionKeySchema } from "./gatewaySessions.ts";
import { jobIdempotencyKeySchema } from "./jobModel.ts";
import type { RawHttpContract } from "./registry.ts";

/** Browser-visible attachment policy shared by ticket preparation and raw uploads. */
export const chatAttachmentLimits = Object.freeze({
    maximumAggregateRawBytes: 16 * 1024 * 1024,
    maximumFileBytes: 16 * 1024 * 1024,
    maximumFiles: 10,
    ticketTtlMs: 5 * 60 * 1000,
});

/** Prefixes intentionally exposed by OpenClaw's reviewed attachment picker. */
export const chatAttachmentAllowedMimePrefixes = Object.freeze(["text/"] as const);

/** Exact binary/text formats for which the raw store has conservative byte checks. */
export const chatAttachmentSniffableMimeTypes = Object.freeze([
    "application/msword",
    "application/pdf",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/zip",
    "audio/aac",
    "audio/flac",
    "audio/mpeg",
    "audio/ogg",
    "audio/opus",
    "audio/wav",
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/heic",
    "image/heif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
] as const);

/** Non-prefix media types that are safe without relying on a filename suffix. */
export const chatAttachmentExactMimeTypes = Object.freeze([
    "application/json",
    ...chatAttachmentSniffableMimeTypes,
] as const);

const chatAttachmentExactMimeTypeSet: ReadonlySet<string> = new Set(
    chatAttachmentExactMimeTypes
);
const chatAttachmentMimeAliases: ReadonlyMap<string, string> = new Map([
    ["application/x-zip", "application/zip"],
    ["application/x-zip-compressed", "application/zip"],
]);
const genericChatAttachmentMimeType = "application/octet-stream";
const chatAttachmentExtensionMimeTypes: ReadonlyMap<string, string> = new Map([
    [".aac", "audio/aac"],
    [".avif", "image/avif"],
    [".bmp", "image/bmp"],
    [".csv", "text/csv"],
    [".doc", "application/msword"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".flac", "audio/flac"],
    [".gif", "image/gif"],
    [".heic", "image/heic"],
    [".heif", "image/heif"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".json", "application/json"],
    [".m2a", "audio/mpeg"],
    [".m4a", "audio/mp4"],
    [".md", "text/markdown"],
    [".mp3", "audio/mpeg"],
    [".oga", "audio/ogg"],
    [".ogg", "audio/ogg"],
    [".opus", "audio/opus"],
    [".pdf", "application/pdf"],
    [".png", "image/png"],
    [".ppt", "application/vnd.ms-powerpoint"],
    [
        ".pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    [".svg", "image/svg+xml"],
    [".txt", "text/plain"],
    [".wav", "audio/wav"],
    [".webp", "image/webp"],
    [".xls", "application/vnd.ms-excel"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".zip", "application/zip"],
]);
const chatAttachmentExtensionMimeAliases: ReadonlyMap<
    string,
    ReadonlySet<string>
> = new Map([
    [".csv", new Set(["application/vnd.ms-excel"])],
    [".docx", new Set(["application/zip"])],
    [".pptx", new Set(["application/zip"])],
    [".xlsx", new Set(["application/zip"])],
]);
const videoChatAttachmentExtensionPattern = /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/iu;
const mimeTypePattern =
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;

/**
 * Returns the last normalized suffix only; paths and compound suffixes grant no authority.
 * @param fileName Untrusted attachment filename.
 * @returns The final lowercase suffix or an empty string.
 */
export function chatAttachmentExtension(fileName: string): string {
    const normalized = fileName.trim().toLowerCase();
    const index = normalized.lastIndexOf(".");
    return index === -1 ? "" : normalized.slice(index);
}

/**
 * Lowercases the declared base type, strips parameters, and resolves safe aliases.
 * @param mimeType Untrusted declared MIME type.
 * @returns The normalized base MIME type.
 */
export function normalizeChatAttachmentDeclaredMimeType(mimeType: string): string {
    const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    return chatAttachmentMimeAliases.get(normalized) ?? normalized;
}

/**
 * Rejects both explicit video types and misleading known video suffixes.
 * @param fileName Untrusted attachment filename.
 * @param mimeType Untrusted declared MIME type.
 * @returns Whether the attachment is a video candidate.
 */
export function isVideoChatAttachment(fileName: string, mimeType: string): boolean {
    return (
        normalizeChatAttachmentDeclaredMimeType(mimeType).startsWith("video/") ||
        videoChatAttachmentExtensionPattern.test(fileName)
    );
}

/**
 * Resolves the one canonical type admitted by the reviewed picker policy.
 * The raw upload adapter must additionally sniff and cross-check the received bytes.
 * @param fileName Untrusted attachment filename.
 * @param mimeType Untrusted declared MIME type.
 * @returns The canonical admitted MIME type, when supported.
 */
export function normalizeChatAttachmentMimeType(
    fileName: string,
    mimeType: string
): string | undefined {
    if (isVideoChatAttachment(fileName, mimeType)) return undefined;
    const declared = normalizeChatAttachmentDeclaredMimeType(mimeType);
    const extension = chatAttachmentExtension(fileName);
    // ISO-BMFF audio/video tracks cannot be distinguished from a declaration or
    // suffix alone. M4A remains unsupported until this boundary parses tracks.
    if (declared === "audio/mp4" || extension === ".m4a") return undefined;
    const extensionMimeType = chatAttachmentExtensionMimeTypes.get(extension);
    if (
        extensionMimeType !== undefined &&
        chatAttachmentExtensionMimeAliases.get(extension)?.has(declared) === true
    ) {
        return extensionMimeType;
    }
    if (
        mimeTypePattern.test(declared) &&
        (chatAttachmentAllowedMimePrefixes.some((prefix) =>
            declared.startsWith(prefix)
        ) ||
            chatAttachmentExactMimeTypeSet.has(declared))
    ) {
        return declared;
    }
    if (
        extensionMimeType !== undefined &&
        (declared === "" ||
            declared === genericChatAttachmentMimeType ||
            declared === extensionMimeType)
    ) {
        return extensionMimeType;
    }
    return undefined;
}

/**
 * Compatibility predicate for call sites that have filename context.
 * @param mimeType Untrusted declared MIME type.
 * @param fileName Optional untrusted attachment filename.
 * @returns Whether the attachment MIME and suffix policy admits the candidate.
 */
export function isAllowedChatAttachmentMimeType(
    mimeType: string,
    fileName = ""
): boolean {
    return normalizeChatAttachmentMimeType(fileName, mimeType) !== undefined;
}

const chatAttachmentFileNameSchema = boundedControlSafeTextSchema(
    255,
    "Chat attachment file name is invalid"
);
const declaredChatAttachmentMimeTypeSchema = v.pipe(
    v.string("Chat attachment MIME type is invalid"),
    v.maxLength(255, "Chat attachment MIME type is invalid"),
    v.check(hasNoUnicodeControlOrFormat, "Chat attachment MIME type is invalid")
);
const chatAttachmentSizeSchema = v.pipe(
    positiveSafeIntegerSchema("Chat attachment size is invalid"),
    v.maxValue(
        chatAttachmentLimits.maximumFileBytes,
        "Chat attachment exceeds its per-file byte budget"
    )
);

/** Canonical lowercase UUIDv4 used by short-lived attachment tickets and file slots. */
export const chatAttachmentTicketIdSchema = v.pipe(
    v.string("Chat attachment ticket id is invalid"),
    v.length(36, "Chat attachment ticket id is invalid"),
    v.uuid("Chat attachment ticket id is invalid"),
    v.regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        "Chat attachment ticket id is invalid"
    )
);

export const chatAttachmentIdSchema = v.pipe(
    v.string("Chat attachment id is invalid"),
    v.length(36, "Chat attachment id is invalid"),
    v.uuid("Chat attachment id is invalid"),
    v.regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        "Chat attachment id is invalid"
    )
);

const chatAttachmentTicketFileObjectSchema = v.strictObject({
    fileName: chatAttachmentFileNameSchema,
    mimeType: declaredChatAttachmentMimeTypeSchema,
    sizeBytes: chatAttachmentSizeSchema,
});

type ChatAttachmentTicketFileInput = v.InferOutput<
    typeof chatAttachmentTicketFileObjectSchema
>;

export function chatAttachmentTicketFileMimeTypeIsSupported(
    file: ChatAttachmentTicketFileInput
): boolean {
    return normalizeChatAttachmentMimeType(file.fileName, file.mimeType) !== undefined;
}

export function normalizeChatAttachmentTicketFile(
    file: ChatAttachmentTicketFileInput
): ChatAttachmentTicketFileInput {
    return {
        ...file,
        mimeType: normalizeChatAttachmentMimeType(file.fileName, file.mimeType)!,
    };
}

export const chatAttachmentTicketFileSchema = v.pipe(
    chatAttachmentTicketFileObjectSchema,
    v.check(
        chatAttachmentTicketFileMimeTypeIsSupported,
        "Chat attachment MIME type is not supported"
    ),
    v.transform(normalizeChatAttachmentTicketFile)
);

type ChatAttachmentTicketFile = v.InferOutput<typeof chatAttachmentTicketFileSchema>;

export function chatAttachmentAggregateRawBytesFit(
    files: ChatAttachmentTicketFile[]
): boolean {
    let bytes = 0;
    for (const file of files) {
        if (bytes > chatAttachmentLimits.maximumAggregateRawBytes - file.sizeBytes) {
            return false;
        }
        bytes += file.sizeBytes;
    }
    return bytes <= chatAttachmentLimits.maximumAggregateRawBytes;
}

const chatAttachmentTicketFilesSchema = v.pipe(
    v.array(chatAttachmentTicketFileSchema, "Chat attachment files are invalid"),
    v.minLength(1, "At least one chat attachment is required"),
    v.maxLength(
        chatAttachmentLimits.maximumFiles,
        "Chat attachment count is outside its budget"
    ),
    v.check(
        chatAttachmentAggregateRawBytesFit,
        "Chat attachments exceed their aggregate raw-byte budget"
    )
);

/** Reserves a session- and idempotency-bound set of one-shot raw upload slots. */
export const chatAttachmentTicketPrepareInputSchema = v.strictObject({
    files: chatAttachmentTicketFilesSchema,
    idempotencyKey: jobIdempotencyKeySchema,
    sessionKey: gatewaySessionKeySchema,
});

export const chatAttachmentUploadSchema = v.strictObject({
    attachmentId: chatAttachmentIdSchema,
    uploadUrl: v.pipe(
        v.string("Chat attachment upload URL is invalid"),
        v.maxLength(512, "Chat attachment upload URL is invalid"),
        v.regex(
            /^\/api\/chat\/attachments\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/u,
            "Chat attachment upload URL is invalid"
        )
    ),
});

const chatAttachmentTicketPrepareOutputObjectSchema = v.strictObject({
    expiresAtMs: timestampMillisecondsSchema("Chat attachment ticket expiry is invalid"),
    ticketId: chatAttachmentTicketIdSchema,
    uploads: v.pipe(
        v.array(chatAttachmentUploadSchema, "Chat attachment uploads are invalid"),
        v.minLength(1, "Chat attachment uploads cannot be empty"),
        v.maxLength(
            chatAttachmentLimits.maximumFiles,
            "Chat attachment upload count is outside its budget"
        )
    ),
});

type ChatAttachmentTicketPrepareOutputValue = v.InferOutput<
    typeof chatAttachmentTicketPrepareOutputObjectSchema
>;

export function chatAttachmentTicketUploadsAreConsistent(
    output: ChatAttachmentTicketPrepareOutputValue
): boolean {
    return (
        hasUniqueArrayItems(output.uploads.map(({ attachmentId }) => attachmentId)) &&
        output.uploads.every(
            ({ attachmentId, uploadUrl }) =>
                uploadUrl === `/api/chat/attachments/${output.ticketId}/${attachmentId}`
        ) &&
        utf8ByteLength(JSON.stringify(output)) <= 8 * 1024
    );
}

/** One bounded ticket and exact same-origin upload URL per reserved file. */
export const chatAttachmentTicketPrepareOutputSchema = v.pipe(
    chatAttachmentTicketPrepareOutputObjectSchema,
    v.check(
        chatAttachmentTicketUploadsAreConsistent,
        "Chat attachment ticket uploads are inconsistent"
    )
);

export type ChatAttachmentTicketPrepareInput = v.InferOutput<
    typeof chatAttachmentTicketPrepareInputSchema
>;
export type ChatAttachmentTicketPrepareOutput = v.InferOutput<
    typeof chatAttachmentTicketPrepareOutputSchema
>;
export type ChatAttachmentUpload = v.InferOutput<typeof chatAttachmentUploadSchema>;

/** Stable raw upload route template published by the contract registry. */
export const chatAttachmentRawUploadPath =
    "/api/chat/attachments/:ticketId/:attachmentId";

/** Stable transcript-authorized media route template published by the registry. */
export const chatMediaRawHttpPath = "/api/chat/media/:attachmentId";

const chatAttachmentRawUploadContentTypes = Object.freeze([
    ...chatAttachmentExactMimeTypes,
    ...chatAttachmentAllowedMimePrefixes.map((prefix) => `${prefix}*`),
]);
const chatMediaDispositionQuery = Object.freeze({
    additionalParameters: "forbidden",
    parameters: Object.freeze([
        Object.freeze({
            name: "disposition",
            required: true,
            values: Object.freeze(["download", "preview"]),
        }),
    ]),
} as const);
const chatAttachmentRawAccess = Object.freeze({
    capabilities: Object.freeze(["chat:write"]),
    capabilityPolicy: "all",
    kind: "authenticated",
} as const);
const chatMediaRawAccess = Object.freeze({
    capabilities: Object.freeze(["chat:read"]),
    capabilityPolicy: "all",
    kind: "authenticated",
} as const);

/** Implemented bounded upload and transcript-authorized media operations. */
export const chatRawHttpContracts = [
    {
        access: chatAttachmentRawAccess,
        method: "PUT",
        path: chatAttachmentRawUploadPath,
        query: {
            additionalParameters: "forbidden",
            parameters: [],
        },
        rangeRequests: "none",
        requestBody: {
            contentTypes: chatAttachmentRawUploadContentTypes,
            kind: "binary",
            maximumBytes: chatAttachmentLimits.maximumFileBytes,
            transfer: "buffered",
        },
        response: { kind: "none" },
        statusCodes: [204, 400, 401, 403, 404, 405, 408, 429],
        summary:
            "Consumes one non-empty, ticket-declared attachment body after MIME and byte verification.",
    },
    {
        access: chatMediaRawAccess,
        method: "GET",
        path: chatMediaRawHttpPath,
        query: chatMediaDispositionQuery,
        rangeRequests: "single-byte-range",
        requestBody: { kind: "none" },
        response: {
            contentTypes: ["*/*"],
            kind: "binary",
            maximumBytes: chatAttachmentLimits.maximumFileBytes,
            transfer: "buffered",
        },
        statusCodes: [200, 206, 400, 401, 403, 404, 405, 415, 416, 429, 502],
        summary:
            "Serves bounded transcript-authorized managed or local-history media through an opaque reference; preview additionally enforces safe MIME policy and a one-MiB text cap.",
    },
    {
        access: chatMediaRawAccess,
        method: "HEAD",
        path: chatMediaRawHttpPath,
        query: chatMediaDispositionQuery,
        rangeRequests: "single-byte-range",
        requestBody: { kind: "none" },
        response: { kind: "none" },
        statusCodes: [200, 206, 400, 401, 403, 404, 405, 415, 416, 429, 502],
        summary:
            "Checks bounded transcript-authorized managed or local-history media metadata without returning a body.",
    },
] as const satisfies readonly RawHttpContract[];
