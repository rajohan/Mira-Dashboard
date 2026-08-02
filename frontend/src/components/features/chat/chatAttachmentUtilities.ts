import {
    type ChatAttachmentDisplay,
    type ChatPreviewItem,
    type ChatSendAttachment,
} from "./chatTypes";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Defines max attachments. */
export const MAX_ATTACHMENTS = 10;
const CHAT_ATTACHMENT_MIME_PREFIXES = ["image/", "audio/", "text/"] as const;
const CHAT_ATTACHMENT_EXACT_MIME_TYPES = new Set(["application/json", "application/pdf"]);
const CHAT_ATTACHMENT_MIME_TYPE_ALIASES = new Map([
    ["application/x-zip", "application/zip"],
    ["application/x-zip-compressed", "application/zip"],
]);
const CHAT_ATTACHMENT_EXTENSION_MIME_ALIASES = new Map<string, ReadonlySet<string>>([
    [".csv", new Set(["application/vnd.ms-excel"])],
    [".docx", new Set(["application/zip"])],
    [".xlsx", new Set(["application/zip"])],
    [".pptx", new Set(["application/zip"])],
]);
const GENERIC_ATTACHMENT_MIME_TYPE = "application/octet-stream";
const CHAT_ATTACHMENT_EXTENSION_MIME_TYPES = new Map<string, string>([
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".webp", "image/webp"],
    [".gif", "image/gif"],
    [".svg", "image/svg+xml"],
    [".heic", "image/heic"],
    [".heif", "image/heif"],
    [".ogg", "audio/ogg"],
    [".oga", "audio/ogg"],
    [".mp3", "audio/mpeg"],
    [".wav", "audio/wav"],
    [".flac", "audio/flac"],
    [".aac", "audio/aac"],
    [".opus", "audio/opus"],
    [".m4a", "audio/mp4"],
    [".m2a", "audio/mpeg"],
    [".pdf", "application/pdf"],
    [".csv", "text/csv"],
    [".json", "application/json"],
    [".md", "text/markdown"],
    [".txt", "text/plain"],
    [".zip", "application/zip"],
    [".doc", "application/msword"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".xls", "application/vnd.ms-excel"],
    [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    [".ppt", "application/vnd.ms-powerpoint"],
    [
        ".pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
]);
const CHAT_ATTACHMENT_EXTENSIONS = CHAT_ATTACHMENT_EXTENSION_MIME_TYPES.keys().toArray();
/** Mirrors OpenClaw Control UI's supported attachment picker. */
export const CHAT_ATTACHMENT_ACCEPT = [
    "image/*",
    "audio/*",
    "application/json",
    "application/pdf",
    "text/*",
    ...CHAT_ATTACHMENT_EXTENSIONS,
].join(",");
/**
 * Returns a normalized filename extension for attachment policy checks.
 * @param fileName File name value.
 * @returns a normalized filename extension for attachment policy checks.
 */
function chatAttachmentExtension(fileName: string): string {
    const normalizedName = fileName.trim().toLowerCase();
    const extensionIndex = normalizedName.lastIndexOf(".");
    return extensionIndex === -1 ? "" : normalizedName.slice(extensionIndex);
}

/**
 * Returns the browser-declared MIME without optional parameters.
 * @param type Type value.
 * @returns the browser-declared MIME without optional parameters.
 */
function declaredChatAttachmentMimeType(type: string): string {
    const mimeType = type.split(";", 1)[0]?.trim().toLowerCase() || "";
    return CHAT_ATTACHMENT_MIME_TYPE_ALIASES.get(mimeType) ?? mimeType;
}

/**
 * Normalizes browser/OS MIME aliases that are safe only for a matching suffix.
 * @returns Normalized browser/OS MIME aliases that are safe only for a matching suffix.
 */
function normalizedChatAttachmentMimeType(file: Pick<File, "name" | "type">): string {
    const declaredMimeType = declaredChatAttachmentMimeType(file.type);
    const extension = chatAttachmentExtension(file.name);
    const extensionMimeType = CHAT_ATTACHMENT_EXTENSION_MIME_TYPES.get(extension);
    if (
        extensionMimeType &&
        CHAT_ATTACHMENT_EXTENSION_MIME_ALIASES.get(extension)?.has(declaredMimeType)
    ) {
        return extensionMimeType;
    }
    return declaredMimeType;
}

/**
 * Returns whether OpenClaw intentionally excludes this video attachment.
 * @returns Whether OpenClaw intentionally excludes this video attachment.
 */
export function isVideoAttachment(file: Pick<File, "name" | "type">): boolean {
    const mimeType = file.type.trim().toLowerCase();
    if (mimeType.startsWith("audio/")) {
        return false;
    }
    return (
        mimeType.startsWith("video/") ||
        /\.(?:avi|m4v|mkv|mov|mp4|mpeg|mpg|webm)$/iu.test(file.name)
    );
}

/**
 * Returns whether a selected or dropped file matches the chat picker policy.
 * @returns Whether a selected or dropped file matches the chat picker policy.
 */
export function isSupportedChatAttachment(file: Pick<File, "name" | "type">): boolean {
    const mimeType = normalizedChatAttachmentMimeType(file);
    if (
        CHAT_ATTACHMENT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix)) ||
        CHAT_ATTACHMENT_EXACT_MIME_TYPES.has(mimeType)
    ) {
        return true;
    }
    const extensionMimeType = CHAT_ATTACHMENT_EXTENSION_MIME_TYPES.get(
        chatAttachmentExtension(file.name)
    );
    return Boolean(
        extensionMimeType &&
        (!mimeType ||
            mimeType === GENERIC_ATTACHMENT_MIME_TYPE ||
            mimeType === extensionMimeType)
    );
}

/**
 * Performs data URL to base64.
 * @param dataUrl Data URL.
 * @returns Data URL to base64 result.
 */
export function dataUrlToBase64(dataUrl: string): string {
    const commaIndex = dataUrl.indexOf(",");
    return commaIndex === -1 ? dataUrl : dataUrl.slice(commaIndex + 1);
}

/**
 * Performs base64 to text.
 * @param base64 Base64 value.
 * @returns Base64 to text result.
 */
export function base64ToText(base64: string): string | undefined {
    try {
        const bytes = Uint8Array.fromBase64(base64);
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    } catch {
        return undefined;
    }
}

/**
 * Returns whether a browser drag contains files from the operating system.
 * @returns Whether a browser drag contains files from the operating system.
 */
export function hasFilesInDataTransfer(dataTransfer: DataTransfer): boolean {
    return [...dataTransfer.types].includes("Files");
}

/**
 * Builds preview data from a received chat attachment.
 * @returns Built preview data from a received chat attachment.
 */
export function previewFromAttachment(
    attachment: ChatAttachmentDisplay
): ChatPreviewItem | undefined {
    if (!attachment.dataUrl && !attachment.url && !attachment.contentBase64) {
        return undefined;
    }

    const mimeType = attachment.mimeType || "application/octet-stream";
    const url =
        attachment.url ||
        attachment.dataUrl ||
        `data:${mimeType};base64,${attachment.contentBase64}`;

    return {
        kind: attachment.kind,
        mimeType,
        sizeBytes: attachment.sizeBytes,
        text:
            attachment.kind === "text" && attachment.contentBase64
                ? base64ToText(attachment.contentBase64)
                : undefined,
        title: attachment.fileName,
        url,
    };
}

/**
 * Builds a preview item from an attachment waiting to be sent.
 * @returns Built a preview item from an attachment waiting to be sent.
 */
export function previewFromSendAttachment(
    attachment: ChatSendAttachment
): ChatPreviewItem {
    return {
        title: attachment.fileName,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        url:
            attachment.dataUrl ||
            `data:${attachment.mimeType};base64,${attachment.contentBase64}`,
        text:
            attachment.kind === "text"
                ? base64ToText(attachment.contentBase64)
                : undefined,
        sizeBytes: attachment.sizeBytes,
    };
}
/**
 * Performs read file as data URL.
 * @returns Read file as data URL result.
 */
export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
                return;
            }

            reject(new Error(`Could not read ${file.name}`));
        });
        reader.addEventListener("error", () =>
            reject(reader.error || new Error(`Could not read ${file.name}`))
        );
        reader.readAsDataURL(file);
    });
}

/**
 * Performs display MIME type.
 * @returns Display MIME type result.
 */
export function displayMimeType(file: File): string {
    const declaredMimeType = normalizedChatAttachmentMimeType(file);
    if (declaredMimeType && declaredMimeType !== GENERIC_ATTACHMENT_MIME_TYPE) {
        return declaredMimeType;
    }
    return (
        CHAT_ATTACHMENT_EXTENSION_MIME_TYPES.get(chatAttachmentExtension(file.name)) ||
        GENERIC_ATTACHMENT_MIME_TYPE
    );
}
