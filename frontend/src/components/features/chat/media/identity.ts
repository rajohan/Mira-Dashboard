import type { ChatAttachmentDisplay } from "./types";

/** Returns a lowercase MIME type without optional parameters. */
export function normalizeChatMimeType(mimeType: string): string {
    return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function unsigned32(value: number): number {
    return value < 0 ? value + 4_294_967_296 : value;
}

/** Returns a compact fingerprint that incorporates every character. */
export function chatContentFingerprint(content: string): string {
    let firstHash = 2_166_136_261;
    let secondHash = 2_654_435_761;
    for (let index = 0; index < content.length; index += 1) {
        const code = content.codePointAt(index) ?? 0;
        firstHash = Math.imul(firstHash ^ code, 16_777_619);
        secondHash = Math.imul(secondHash ^ code, 2_246_822_519);
    }
    return `${content.length}:${unsigned32(firstHash).toString(36)}:${unsigned32(
        secondHash
    ).toString(36)}`;
}

/** Returns attachment content identity independent of transient row IDs. */
export function chatAttachmentIdentity(attachment: ChatAttachmentDisplay): string {
    const content =
        attachment.contentBase64 || attachment.dataUrl || attachment.url || "";
    return [
        attachment.fileName,
        attachment.mimeType || "unknown",
        attachment.sizeBytes ?? "unknown",
        content ? chatContentFingerprint(content) : attachment.id,
    ].join("::");
}
