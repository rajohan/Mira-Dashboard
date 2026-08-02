import {
    type CanonicalChatAttachment,
    type CanonicalChatImage,
    type CanonicalChatMessage,
    type CanonicalChatToolResult,
} from "./canonical";
import {
    canonicalChatAttachmentKind,
    mergeCanonicalChatAttachments,
} from "./canonicalAttachments";
import {
    extractCanonicalChatThinking,
    extractCanonicalChatToolCalls,
    normalizeCanonicalChatText,
} from "./canonicalContentBlocks";
import { canonicalizeCanonicalChatMedia } from "./canonicalImages";
import {
    canonicalChatImageDisplayUrl,
    canonicalChatLocalMediaPathFromUrl,
    canonicalChatPortableDashboardMediaUrl,
} from "./canonicalImageUrls";
import {
    canonicalIsoString,
    MAX_CANONICAL_TOOL_RESULT_CHARACTERS,
    truncateCanonicalChatText,
} from "./canonicalUtilities";

const REMOTE_MEDIA_PROTOCOLS = new Set(["http:", "https:"]);

export interface RawOpenClawHistoryMessage {
    __openclaw?: unknown;
    role?: unknown;
    content?: unknown;
    text?: unknown;
    timestamp?: unknown;
    command?: unknown;
    toolCallId?: unknown;
    tool_call_id?: unknown;
    toolName?: unknown;
    tool_name?: unknown;
    isError?: unknown;
    MediaPath?: unknown;
    MediaPaths?: unknown;
    MediaType?: unknown;
    MediaTypes?: unknown;
    model?: unknown;
    provider?: unknown;
    idempotencyKey?: unknown;
    runId?: unknown;
    stopReason?: unknown;
}

function historyMetadata(message: RawOpenClawHistoryMessage): Record<string, unknown> {
    return message.__openclaw &&
        typeof message.__openclaw === "object" &&
        !Array.isArray(message.__openclaw)
        ? (message.__openclaw as Record<string, unknown>)
        : {};
}

function isInjectedControlMessage(message: RawOpenClawHistoryMessage): boolean {
    return (
        stringValue(message.provider)?.toLowerCase() === "openclaw" &&
        stringValue(message.model)?.toLowerCase() === "gateway-injected"
    );
}

function normalizedIsFinal(message: RawOpenClawHistoryMessage): true | undefined {
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
    if (
        (role === "assistant" || role === "system") &&
        typeof message.stopReason === "string" &&
        message.stopReason.toLowerCase() === "stop"
    ) {
        return true;
    }
    return undefined;
}

function normalizedIsToolUse(message: RawOpenClawHistoryMessage): true | undefined {
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
    if (
        role === "assistant" &&
        typeof message.stopReason === "string" &&
        message.stopReason.toLowerCase() === "tooluse"
    ) {
        return true;
    }
    return undefined;
}

function normalizedRunId(message: RawOpenClawHistoryMessage): string | undefined {
    const runId = typeof message.runId === "string" ? message.runId.trim() : "";
    if (runId) {
        return runId;
    }
    if (
        typeof message.role !== "string" ||
        message.role.toLowerCase() !== "user" ||
        typeof message.idempotencyKey !== "string"
    ) {
        return undefined;
    }
    const match = message.idempotencyKey.match(/^(dashboard-chat-.+):user$/u);
    return match?.[1];
}

function fileNameFromPath(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

function pathFromMediaRef(reference: string): string {
    const localMediaPath = canonicalChatLocalMediaPathFromUrl(reference);
    if (localMediaPath) {
        return localMediaPath;
    }
    try {
        const url = new URL(reference, "https://dashboard.invalid");
        if (
            reference.startsWith("/") ||
            REMOTE_MEDIA_PROTOCOLS.has(url.protocol) ||
            url.protocol === "file:"
        ) {
            return decodeURIComponent(url.pathname);
        }
    } catch {
        // Fall through to the original reference when it is not a valid URL.
    }
    return reference;
}

function mimeTypeFromPath(path: string): string {
    const extension = path.split("./transport").pop()?.toLowerCase() || "";
    const mimeTypes: Record<string, string> = {
        aac: "audio/aac",
        bmp: "image/bmp",
        csv: "text/csv",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        flac: "audio/flac",
        gif: "image/gif",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        json: "application/json",
        m4a: "audio/mp4",
        md: "text/markdown",
        mp3: "audio/mpeg",
        mp4: "video/mp4",
        oga: "audio/ogg",
        ogg: "audio/ogg",
        opus: "audio/opus",
        pdf: "application/pdf",
        png: "image/png",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        svg: "image/svg+xml",
        txt: "text/plain",
        wav: "audio/wav",
        webm: "video/webm",
        webp: "image/webp",
        xls: "application/vnd.ms-excel",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        zip: "application/zip",
    };
    return mimeTypes[extension] || "application/octet-stream";
}

function mediaUrlFromPath(path: string): string {
    return `/api/media?path=${encodeURIComponent(path)}`;
}

function displayUrlFromMediaRef(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const candidate = value.trim();
    if (!candidate) {
        return undefined;
    }
    if (candidate.startsWith("/api/")) {
        return candidate;
    }
    if (candidate.startsWith("/")) {
        return mediaUrlFromPath(candidate);
    }
    try {
        const url = new URL(candidate);
        const dashboardMediaUrl = canonicalChatPortableDashboardMediaUrl(candidate);
        if (dashboardMediaUrl) {
            return dashboardMediaUrl;
        }
        if (REMOTE_MEDIA_PROTOCOLS.has(url.protocol)) {
            return candidate;
        }
        if (url.protocol === "file:") {
            return mediaUrlFromPath(decodeURIComponent(url.pathname));
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function stringValues(plural: unknown, singular: unknown): string[] {
    if (Array.isArray(plural)) {
        return plural.filter((value): value is string => typeof value === "string");
    }
    return typeof singular === "string" ? [singular] : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedTimestamp(value: unknown): string | undefined {
    let timestamp: number;
    if (typeof value === "number") {
        timestamp = value;
    } else if (typeof value === "string") {
        timestamp = Date.parse(value);
    } else {
        return undefined;
    }
    return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())
        ? canonicalIsoString(timestamp)
        : undefined;
}

function mediaDirectiveAttachments(text: string): CanonicalChatAttachment[] {
    const attachments: CanonicalChatAttachment[] = [];
    for (const match of text.matchAll(/^MEDIA:(.+)$/gm)) {
        const mediaPath = match[1]?.trim();
        if (!mediaPath) {
            continue;
        }
        const mimeType = mimeTypeFromPath(mediaPath);
        const kind = canonicalChatAttachmentKind(mimeType);
        attachments.push({
            id: `media-${mediaPath}-${attachments.length}`,
            fileName: fileNameFromPath(mediaPath),
            mimeType,
            dataUrl:
                kind === "image"
                    ? canonicalChatImageDisplayUrl(mediaUrlFromPath(mediaPath), mimeType)
                    : undefined,
            url: mediaUrlFromPath(mediaPath),
            kind,
        });
    }
    return attachments;
}

function inlineFileAttachments(text: string): CanonicalChatAttachment[] {
    const pattern = /<file\s+name="([^"]+)"\s+mime="([^"]+)">([\s\S]*?)<\/file>/g;
    const attachments: CanonicalChatAttachment[] = [];
    for (const match of text.matchAll(pattern)) {
        const [
            ,
            fileName = "attachment",
            mimeType = "application/octet-stream",
            body = "",
        ] = match;
        const normalizedFileName = fileName.trim() || "attachment";
        const external = body.match(
            /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?\n---\n([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/
        );
        const content = (external?.[1] ?? body).trim();
        const bytes = new TextEncoder().encode(content);
        const contentBase64 = bytes.toBase64();
        const kind = canonicalChatAttachmentKind(mimeType);
        attachments.push({
            id: `inline-${normalizedFileName}-${attachments.length}`,
            fileName: normalizedFileName,
            mimeType,
            sizeBytes: bytes.byteLength,
            contentBase64,
            dataUrl:
                kind === "image" ? `data:${mimeType};base64,${contentBase64}` : undefined,
            kind,
        });
    }
    return attachments;
}

function mediaReferenceAttachments(
    message: RawOpenClawHistoryMessage
): CanonicalChatAttachment[] {
    const paths = stringValues(message.MediaPaths, message.MediaPath);
    const types = stringValues(message.MediaTypes, message.MediaType);
    return paths.flatMap((rawPath, index) => {
        const path = rawPath.trim();
        if (!path) {
            return [];
        }
        const mimeType = stringValue(types[index]) || mimeTypeFromPath(path);
        const kind = canonicalChatAttachmentKind(mimeType);
        return [
            {
                id: `${path}-${index}`,
                fileName: fileNameFromPath(path),
                mimeType,
                dataUrl:
                    kind === "image"
                        ? canonicalChatImageDisplayUrl(mediaUrlFromPath(path), mimeType)
                        : undefined,
                url: mediaUrlFromPath(path),
                kind,
            },
        ];
    });
}

function contentBlockAttachments(content: unknown): CanonicalChatAttachment[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const attachments: CanonicalChatAttachment[] = [];
    for (const block of content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) {
            continue;
        }
        const record = block as Record<string, unknown>;
        if (
            record.type !== "attachment" ||
            !record.attachment ||
            typeof record.attachment !== "object" ||
            Array.isArray(record.attachment)
        ) {
            continue;
        }
        const attachment = record.attachment as Record<string, unknown>;
        const url = displayUrlFromMediaRef(attachment.url);
        if (!url) {
            continue;
        }
        const rawUrl = typeof attachment.url === "string" ? attachment.url : "";
        const attachmentPath = pathFromMediaRef(rawUrl);
        const label =
            typeof attachment.label === "string" && attachment.label.trim()
                ? attachment.label.trim()
                : fileNameFromPath(attachmentPath);
        const labelMimeType = mimeTypeFromPath(label);
        let mimeType = labelMimeType;
        if (typeof attachment.mimeType === "string" && attachment.mimeType.trim()) {
            mimeType = attachment.mimeType.trim();
        } else if (labelMimeType === "application/octet-stream") {
            mimeType = mimeTypeFromPath(attachmentPath);
        }
        const kind = canonicalChatAttachmentKind(mimeType);
        attachments.push({
            id: `content-${url}-${attachments.length}`,
            fileName: label || "attachment",
            mimeType,
            dataUrl:
                kind === "image"
                    ? canonicalChatImageDisplayUrl(url, mimeType)
                    : undefined,
            url,
            kind,
        });
    }
    return attachments;
}

function stripAttachmentMarkup(text: string): string {
    return text
        .replaceAll(/^MEDIA:.+$/gm, "")
        .replaceAll(/^\[media attached: .*?\]\n?/gm, "")
        .replaceAll(/<file\s+name="[^"]+"\s+mime="[^"]+">[\s\S]*?<\/file>/g, "")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim();
}

function primaryContent(content: unknown): unknown {
    return Array.isArray(content)
        ? content.filter((block) => {
              if (!block || typeof block !== "object") {
                  return true;
              }
              const type = (block as { type?: unknown }).type;
              return typeof type !== "string" || !["thinking", "toolCall"].includes(type);
          })
        : content;
}

function toolResult(
    message: RawOpenClawHistoryMessage,
    content: unknown,
    images: CanonicalChatImage[]
): CanonicalChatToolResult | undefined {
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
    if (!role.startsWith("tool")) {
        return undefined;
    }
    const toolCallId =
        stringValue(message.toolCallId) || stringValue(message.tool_call_id);
    const toolName = stringValue(message.toolName) || stringValue(message.tool_name);
    return {
        id: toolCallId,
        name: toolName,
        content: truncateCanonicalChatText(
            normalizeCanonicalChatText(content),
            MAX_CANONICAL_TOOL_RESULT_CHARACTERS
        ),
        isError: typeof message.isError === "boolean" ? message.isError : undefined,
        images,
    };
}

function stripGeneratedImagePlaceholder(
    text: string,
    images: CanonicalChatImage[],
    attachments: CanonicalChatAttachment[]
): string {
    if (images.length === 0 && attachments.length === 0) {
        return text;
    }
    return text
        .split("\n")
        .filter((line) => line.trim() !== "[image]")
        .join("\n")
        .trimEnd();
}

/**
 * Converts one raw OpenClaw transcript row into the canonical message model.
 * @returns Converted one raw OpenClaw transcript row into the canonical message model.
 */
export function normalizeOpenClawHistoryMessage(
    message: RawOpenClawHistoryMessage
): CanonicalChatMessage {
    const isControl = isInjectedControlMessage(message);
    const content = message.content ?? message.text ?? "";
    const primaryText = normalizeCanonicalChatText(primaryContent(content));
    const canonicalMedia = canonicalizeCanonicalChatMedia(content);
    const images = canonicalMedia.images;
    const attachments = mergeCanonicalChatAttachments(
        mediaReferenceAttachments(message),
        [
            ...mediaDirectiveAttachments(primaryText),
            ...inlineFileAttachments(primaryText),
            ...contentBlockAttachments(content),
        ]
    );
    const text = stripGeneratedImagePlaceholder(
        stripAttachmentMarkup(primaryText),
        images,
        attachments
    );
    let role = typeof message.role === "string" ? message.role : "unknown";
    if (isControl) {
        role = "system";
    }
    return {
        role,
        content: canonicalMedia.content,
        controlId: isControl ? stringValue(historyMetadata(message).id) : undefined,
        text,
        images,
        intent: isControl ? "control" : undefined,
        attachments,
        isFinal: normalizedIsFinal(message),
        isToolUse: normalizedIsToolUse(message),
        thinking: extractCanonicalChatThinking(content),
        toolCalls: extractCanonicalChatToolCalls(content),
        toolResult: toolResult(message, content, images),
        runId: normalizedRunId(message),
        timestamp: normalizedTimestamp(message.timestamp),
    };
}
