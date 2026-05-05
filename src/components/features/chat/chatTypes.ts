export interface ChatImageBlock {
    type: "image";
    mimeType?: string;
    data?: string;
    source?: {
        type?: string;
        media_type?: string;
        data?: string;
    };
}

export interface ChatAttachmentDisplay {
    id: string;
    fileName: string;
    mimeType?: string;
    sizeBytes?: number;
    dataUrl?: string;
    contentBase64?: string;
    kind: "image" | "text" | "file";
}

export interface ChatPreviewItem {
    title: string;
    mimeType?: string;
    kind: "image" | "text" | "file";
    url?: string;
    text?: string;
    sizeBytes?: number;
}

export interface ChatSendAttachment {
    id: string;
    file: File;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    contentBase64: string;
    dataUrl?: string;
    kind: "image" | "text" | "file";
}

export interface ChatGatewayAttachment {
    type: string;
    mimeType: string;
    fileName: string;
    content: string;
}

export interface ChatHistoryMessage {
    role: string;
    content: unknown;
    text: string;
    images?: ChatImageBlock[];
    attachments?: ChatAttachmentDisplay[];
    timestamp?: string;
}

export interface RawChatHistoryMessage {
    role?: string;
    content?: unknown;
    text?: string;
    timestamp?: string | number;
    MediaPath?: string;
    MediaPaths?: string[];
    MediaType?: string;
    MediaTypes?: string[];
}

export interface ChatStreamEventMessage {
    sessionKey?: string;
    runId?: string;
    state?: string;
    errorMessage?: string;
    message?: unknown;
    content?: unknown;
    text?: string;
    delta?: unknown;
}

export interface ChatRow {
    key: string;
    kind: "message" | "stream" | "typing";
    message: ChatHistoryMessage;
}

export function extractImages(content: unknown): ChatImageBlock[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter((item): item is ChatImageBlock => {
        if (!item || typeof item !== "object") {
            return false;
        }

        const block = item as Record<string, unknown>;
        return block.type === "image";
    });
}

export function attachmentKind(mimeType: string): ChatAttachmentDisplay["kind"] {
    if (mimeType.startsWith("image/")) {
        return "image";
    }

    if (mimeType.startsWith("text/") || mimeType === "application/json") {
        return "text";
    }

    return "file";
}

export function gatewayAttachments(
    attachments: ChatSendAttachment[]
): ChatGatewayAttachment[] {
    return attachments.map((attachment) => ({
        type: attachment.kind,
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        content: attachment.contentBase64,
    }));
}

export function optimisticAttachmentDisplay(
    attachments: ChatSendAttachment[]
): ChatAttachmentDisplay[] {
    return attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl: attachment.dataUrl,
        contentBase64: attachment.contentBase64,
        kind: attachment.kind,
    }));
}

function fileNameFromPath(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}

function textToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return window.btoa(binary);
}

function extractInlineFileAttachments(text: string): ChatAttachmentDisplay[] {
    const filePattern = /<file\s+name="([^"]+)"\s+mime="([^"]+)">([\s\S]*?)<\/file>/g;
    const attachments: ChatAttachmentDisplay[] = [];

    for (const match of text.matchAll(filePattern)) {
        const [
            ,
            fileName = "attachment",
            mimeType = "application/octet-stream",
            body = "",
        ] = match;
        const externalContentMatch = body.match(
            /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?\n---\n([\s\S]*?)<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/
        );
        const content = (externalContentMatch?.[1] ?? body).trim();
        const contentBytes = new TextEncoder().encode(content);
        const contentBase64 = textToBase64(content);
        const kind = attachmentKind(mimeType);

        attachments.push({
            id: `inline-${fileName}-${attachments.length}`,
            fileName,
            mimeType,
            sizeBytes: contentBytes.byteLength,
            contentBase64,
            dataUrl:
                kind === "image" ? `data:${mimeType};base64,${contentBase64}` : undefined,
            kind,
        });
    }

    return attachments;
}

function stripInlineFileMarkup(text: string): string {
    return text
        .replaceAll(/^\[media attached: .*?\]\n?/gm, "")
        .replaceAll(/<file\s+name="[^"]+"\s+mime="[^"]+">[\s\S]*?<\/file>/g, "")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim();
}

function extractMediaReferenceAttachments(
    message: RawChatHistoryMessage
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
        const mimeType = types[index] || "application/octet-stream";

        return {
            id: `${path}-${index}`,
            fileName: fileNameFromPath(path),
            mimeType,
            kind: attachmentKind(mimeType),
        };
    });
}

function stripGeneratedMediaOnlyText(
    text: string,
    images: ChatImageBlock[],
    attachments: ChatAttachmentDisplay[]
): string {
    const trimmed = text.trim();
    const hasRenderableMedia = images.length > 0 || attachments.length > 0;

    if (!hasRenderableMedia) {
        return text;
    }

    if (trimmed === "[image]") {
        return "";
    }

    return text
        .split("\n")
        .filter((line) => line.trim() !== "[image]")
        .join("\n")
        .trimEnd();
}

export function normalizeChatHistoryMessage(
    message: RawChatHistoryMessage
): ChatHistoryMessage {
    const content = message.content ?? message.text ?? "";
    const images = extractImages(content);
    const normalizedText = normalizeText(content);
    const attachments = [
        ...extractMediaReferenceAttachments(message),
        ...extractInlineFileAttachments(normalizedText),
    ];
    const text = stripGeneratedMediaOnlyText(
        stripInlineFileMarkup(normalizedText),
        images,
        attachments
    );

    return {
        role: message.role || "unknown",
        content,
        text,
        images,
        attachments,
        timestamp:
            typeof message.timestamp === "number"
                ? new Date(message.timestamp).toISOString()
                : message.timestamp,
    };
}

export function normalizeText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") {
                    return item;
                }

                if (!item || typeof item !== "object") {
                    return "";
                }

                const block = item as Record<string, unknown>;
                if (typeof block.text === "string") {
                    return block.text;
                }

                if (block.type === "image") {
                    return "[image]";
                }

                return "";
            })
            .filter(Boolean)
            .join("\n\n");
    }

    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        if (typeof maybe.text === "string") {
            return maybe.text;
        }
    }

    return "";
}

export function isRenderableChatHistoryMessage(message: ChatHistoryMessage): boolean {
    const role = message.role.toLowerCase();
    if (role === "tool" || role === "toolresult" || role === "tool_result") {
        return false;
    }

    return Boolean(
        message.text.trim() ||
        (message.images?.length || 0) > 0 ||
        (message.attachments?.length || 0) > 0
    );
}

export function normalizeVisibleChatHistoryMessages(
    messages: RawChatHistoryMessage[]
): ChatHistoryMessage[] {
    return messages
        .map(normalizeChatHistoryMessage)
        .filter(isRenderableChatHistoryMessage);
}
