import {
    File,
    FileArchive,
    FileImage,
    FileMusic,
    FileText,
    type LucideIcon,
} from "lucide-react";

import type { ChatDraftAttachment } from "./chatTypes.ts";

/**
 * Selects a provider-neutral file-type glyph for attachment inventories and previews.
 * @param mediaType Reviewed canonical attachment MIME type.
 * @returns Shared decorative file-type icon.
 */
export function chatAttachmentIcon(mediaType: string): LucideIcon {
    if (mediaType.startsWith("image/")) return FileImage;
    if (mediaType.startsWith("audio/")) return FileMusic;
    if (mediaType.startsWith("text/")) return FileText;
    if (mediaType === "application/pdf") return FileText;
    if (mediaType === "application/json") return FileText;
    if (mediaType === "application/zip") return FileArchive;
    return File;
}

/**
 * Formats bounded attachment bytes without exposing raw file content.
 * @param bytes Non-negative attachment byte count.
 * @returns Compact binary size label.
 */
export function formatChatAttachmentSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kibibytes = bytes / 1024;
    if (kibibytes < 1024) return `${kibibytes.toFixed(kibibytes < 10 ? 1 : 0)} KiB`;
    const mebibytes = kibibytes / 1024;
    return `${mebibytes.toFixed(mebibytes < 10 ? 1 : 0)} MiB`;
}

/**
 * Converts a canonical MIME declaration into a short readable type.
 * @param mediaType Reviewed canonical attachment MIME type.
 * @returns Human-readable file type label.
 */
export function chatAttachmentTypeLabel(mediaType: string): string {
    const [family = "file", subtype = ""] = mediaType.split("/", 2);
    const normalizedSubtype = subtype
        .replace(/^vnd\./u, "")
        .replaceAll(/[.+-]/gu, " ")
        .trim();
    if (family === "image") return `${normalizedSubtype || "image"} image`;
    if (family === "audio") return `${normalizedSubtype || "audio"} audio`;
    if (family === "text") return `${normalizedSubtype || "plain"} text`;
    return normalizedSubtype || mediaType;
}

/**
 * Returns one accessible draft-upload lifecycle label.
 * @param attachment Prepared composer attachment.
 * @returns Explicit status/progress text.
 */
export function chatAttachmentStatusLabel(
    attachment: Pick<ChatDraftAttachment, "progress" | "status">
): string {
    if (attachment.status === "preparing") return "Preparing";
    if (attachment.status === "uploading") return `Uploading ${attachment.progress}%`;
    if (attachment.status === "error") return "Upload failed";
    return "Ready";
}
