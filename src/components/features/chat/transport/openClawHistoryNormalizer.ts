import { isoStringFromDate } from "../../../../utils/date";
import {
    attachmentKind,
    type ChatAttachmentDisplay,
    type ChatHistoryMessage,
    type ChatImageBlock,
    chatImageDisplayUrl,
    chatLocalMediaPathFromUrl,
    type ChatToolResultDisplay,
    extractImages,
    extractThinkingBlocks,
    extractToolCalls,
    mergeChatAttachments,
    normalizeText,
} from "../chatTypes";

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
    idempotencyKey?: unknown;
    runId?: unknown;
    stopReason?: unknown;
}

function normalizedIsFinal(message: RawOpenClawHistoryMessage): true | undefined {
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
    return (role === "assistant" || role === "system") &&
        typeof message.stopReason === "string" &&
        message.stopReason.toLowerCase() === "stop"
        ? true
        : undefined;
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

function pathFromMediaReference(reference: string): string {
    const localMediaPath = chatLocalMediaPathFromUrl(reference);
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
    const extension = path.split(".").pop()?.toLowerCase() || "";
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

function displayUrlFromMediaReference(value: unknown): string | undefined {
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

function normalizedTimestamp(value: unknown): string | undefined {
    const timestamp =
        typeof value === "number"
            ? value
            : typeof value === "string"
              ? Date.parse(value)
              : NaN;
    return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime())
        ? isoStringFromDate(timestamp)
        : undefined;
}

function mediaDirectiveAttachments(text: string): ChatAttachmentDisplay[] {
    const attachments: ChatAttachmentDisplay[] = [];
    for (const match of text.matchAll(/^MEDIA:(.+)$/gm)) {
        const mediaPath = match[1]?.trim();
        if (!mediaPath) {
            continue;
        }
        const mimeType = mimeTypeFromPath(mediaPath);
        const kind = attachmentKind(mimeType);
        attachments.push({
            id: `media-${mediaPath}-${attachments.length}`,
            fileName: fileNameFromPath(mediaPath),
            mimeType,
            dataUrl:
                kind === "image"
                    ? chatImageDisplayUrl(mediaUrlFromPath(mediaPath), mimeType)
                    : undefined,
            url: mediaUrlFromPath(mediaPath),
            kind,
        });
    }
    return attachments;
}

function inlineFileAttachments(text: string): ChatAttachmentDisplay[] {
    const pattern = /<file\s+name="([^"]+)"\s+mime="([^"]+)">([\s\S]*?)<\/file>/g;
    const attachments: ChatAttachmentDisplay[] = [];
    for (const match of text.matchAll(pattern)) {
        const [
            ,
            fileName = "attachment",
            mimeType = "application/octet-stream",
            body = "",
        ] = match;
        const external = body.match(
            /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?\n---\n([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/
        );
        const content = (external?.[1] ?? body).trim();
        const bytes = new TextEncoder().encode(content);
        const contentBase64 = bytes.toBase64();
        const kind = attachmentKind(mimeType);
        attachments.push({
            id: `inline-${fileName}-${attachments.length}`,
            fileName,
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
): ChatAttachmentDisplay[] {
    const paths = Array.isArray(message.MediaPaths)
        ? message.MediaPaths.map(String)
        : message.MediaPath !== undefined && message.MediaPath !== null
          ? [String(message.MediaPath)]
          : [];
    const types = Array.isArray(message.MediaTypes)
        ? message.MediaTypes.map(String)
        : message.MediaType !== undefined && message.MediaType !== null
          ? [String(message.MediaType)]
          : [];
    return paths.map((path, index) => {
        const mimeType = types[index] || mimeTypeFromPath(path);
        const kind = attachmentKind(mimeType);
        return {
            id: `${path}-${index}`,
            fileName: fileNameFromPath(path),
            mimeType,
            dataUrl:
                kind === "image"
                    ? chatImageDisplayUrl(mediaUrlFromPath(path), mimeType)
                    : undefined,
            url: mediaUrlFromPath(path),
            kind,
        };
    });
}

function contentBlockAttachments(content: unknown): ChatAttachmentDisplay[] {
    if (!Array.isArray(content)) {
        return [];
    }
    const attachments: ChatAttachmentDisplay[] = [];
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
        const url = displayUrlFromMediaReference(attachment.url);
        if (!url) {
            continue;
        }
        const rawUrl = typeof attachment.url === "string" ? attachment.url : "";
        const attachmentPath = pathFromMediaReference(rawUrl);
        const label =
            typeof attachment.label === "string" && attachment.label.trim()
                ? attachment.label.trim()
                : fileNameFromPath(attachmentPath);
        const labelMimeType = mimeTypeFromPath(label);
        const mimeType =
            typeof attachment.mimeType === "string" && attachment.mimeType.trim()
                ? attachment.mimeType.trim()
                : labelMimeType === "application/octet-stream"
                  ? mimeTypeFromPath(attachmentPath)
                  : labelMimeType;
        const kind = attachmentKind(mimeType);
        attachments.push({
            id: `content-${url}-${attachments.length}`,
            fileName: label || "attachment",
            mimeType,
            dataUrl: kind === "image" ? chatImageDisplayUrl(url, mimeType) : undefined,
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
        ? content.filter(
              (block) =>
                  !block ||
                  typeof block !== "object" ||
                  !["thinking", "toolCall"].includes(
                      String((block as { type?: unknown }).type)
                  )
          )
        : content;
}

function toolResult(
    message: RawOpenClawHistoryMessage,
    content: unknown
): ChatToolResultDisplay | undefined {
    const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
    if (!role.startsWith("tool")) {
        return undefined;
    }
    return {
        id:
            typeof message.toolCallId === "string"
                ? message.toolCallId
                : typeof message.tool_call_id === "string"
                  ? message.tool_call_id
                  : undefined,
        name:
            typeof message.toolName === "string"
                ? message.toolName
                : typeof message.tool_name === "string"
                  ? message.tool_name
                  : undefined,
        content: normalizeText(content),
        isError: typeof message.isError === "boolean" ? message.isError : undefined,
        images: extractImages(content),
    };
}

function stripGeneratedImagePlaceholder(
    text: string,
    images: ChatImageBlock[],
    attachments: ChatAttachmentDisplay[]
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

/** Converts one raw OpenClaw transcript row into the canonical message model. */
export function normalizeOpenClawHistoryMessage(
    message: RawOpenClawHistoryMessage
): ChatHistoryMessage {
    const content = message.content ?? message.text ?? "";
    const primaryText = normalizeText(primaryContent(content));
    const images = extractImages(content);
    const attachments = mergeChatAttachments(mediaReferenceAttachments(message), [
        ...mediaDirectiveAttachments(primaryText),
        ...inlineFileAttachments(primaryText),
        ...contentBlockAttachments(content),
    ]);
    const text = stripGeneratedImagePlaceholder(
        stripAttachmentMarkup(primaryText),
        images,
        attachments
    );
    return {
        role: typeof message.role === "string" ? message.role : "unknown",
        content,
        text,
        images,
        attachments,
        isFinal: normalizedIsFinal(message),
        thinking: extractThinkingBlocks(content),
        toolCalls: extractToolCalls(content),
        toolResult: toolResult(message, content),
        runId: normalizedRunId(message),
        timestamp: normalizedTimestamp(message.timestamp),
    };
}
