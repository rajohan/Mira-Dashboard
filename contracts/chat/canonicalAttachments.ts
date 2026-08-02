import type { CanonicalChatAttachment } from "./canonical";
import { canonicalChatContentFingerprint } from "./canonicalContentIdentity";

/**
 * Returns a lowercase MIME type without optional parameters.
 * @param mimeType MIME type to normalize.
 * @returns Normalized MIME type.
 */
export function normalizeCanonicalChatMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function attachmentIdentity(attachment: CanonicalChatAttachment): string {
    const content =
        attachment.contentBase64 || attachment.dataUrl || attachment.url || "";
    return [
        attachment.fileName,
        attachment.mimeType || "unknown",
        attachment.sizeBytes ?? "unknown",
        content ? canonicalChatContentFingerprint(content) : attachment.id,
    ].join("::");
}

/**
 * Merges canonical attachments without repeating content identity.
 * @param previous Previously collected attachments.
 * @param next Incoming attachments.
 * @returns Attachments in first-seen order.
 */
export function mergeCanonicalChatAttachments(
    previous: CanonicalChatAttachment[] = [],
    next: CanonicalChatAttachment[] = []
): CanonicalChatAttachment[] {
    const seen = new Set<string>();
    return [...previous, ...next].filter((attachment) => {
        const identity = attachmentIdentity(attachment);
        if (seen.has(identity)) {
            return false;
        }
        seen.add(identity);
        return true;
    });
}

/**
 * Returns the display kind for a MIME type.
 * @param mimeType MIME type to classify.
 * @returns Canonical attachment kind.
 */
export function canonicalChatAttachmentKind(
    mimeType: string
): CanonicalChatAttachment["kind"] {
    const normalized = normalizeCanonicalChatMimeType(mimeType);
    if (normalized.startsWith("image/")) {
        return "image";
    }
    if (normalized === "application/json" || normalized.startsWith("text/")) {
        return "text";
    }
    return "file";
}
