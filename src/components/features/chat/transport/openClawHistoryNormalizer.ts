import { isoStringFromDate } from "../../../../utils/date";
import {
    attachmentKind,
    type ChatAttachmentDisplay,
    type ChatHistoryMessage,
    type ChatImageBlock,
    type ChatToolResultDisplay,
    extractImages,
    extractThinkingBlocks,
    extractToolCalls,
    normalizeText,
} from "../chatTypes";

export interface RawOpenClawHistoryMessage {
    role?: string;
    content?: unknown;
    text?: string;
    timestamp?: string | number;
    command?: boolean;
    toolCallId?: string;
    tool_call_id?: string;
    toolName?: string;
    tool_name?: string;
    isError?: boolean;
    MediaPath?: string;
    MediaPaths?: string[];
    MediaType?: string;
    MediaTypes?: string[];
    runId?: string;
}

function fileNameFromPath(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

function mimeTypeFromPath(path: string): string {
    const extension = path.split(".").pop()?.toLowerCase() || "";
    const mimeTypes: Record<string, string> = {
        bmp: "image/bmp",
        gif: "image/gif",
        jpeg: "image/jpeg",
        jpg: "image/jpeg",
        json: "application/json",
        mp3: "audio/mpeg",
        mp4: "video/mp4",
        png: "image/png",
        svg: "image/svg+xml",
        txt: "text/plain",
        wav: "audio/wav",
        webm: "video/webm",
        webp: "image/webp",
    };
    return mimeTypes[extension] || "application/octet-stream";
}

function mediaUrlFromPath(path: string): string {
    return `/api/media?path=${encodeURIComponent(path)}`;
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
            dataUrl: kind === "image" ? mediaUrlFromPath(mediaPath) : undefined,
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
        ? message.MediaPaths
        : message.MediaPath
          ? [message.MediaPath]
          : [];
    const types = Array.isArray(message.MediaTypes)
        ? message.MediaTypes
        : message.MediaType
          ? [message.MediaType]
          : [];
    return paths.map((path, index) => {
        const mimeType = types[index] || mimeTypeFromPath(path);
        const kind = attachmentKind(mimeType);
        return {
            id: `${path}-${index}`,
            fileName: fileNameFromPath(path),
            mimeType,
            dataUrl: kind === "image" ? mediaUrlFromPath(path) : undefined,
            kind,
        };
    });
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
    const role = message.role?.toLowerCase() || "";
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
        isError: message.isError,
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
    const attachments = [
        ...mediaReferenceAttachments(message),
        ...mediaDirectiveAttachments(primaryText),
        ...inlineFileAttachments(primaryText),
    ];
    const text = stripGeneratedImagePlaceholder(
        stripAttachmentMarkup(primaryText),
        images,
        attachments
    );
    return {
        role: message.role || "unknown",
        content,
        text,
        images,
        attachments,
        thinking: extractThinkingBlocks(content),
        toolCalls: extractToolCalls(content),
        toolResult: toolResult(message, content),
        runId: message.runId,
        timestamp:
            typeof message.timestamp === "number"
                ? isoStringFromDate(message.timestamp)
                : message.timestamp,
    };
}
