import { mergeCanonicalChatImages } from "../../../../../../contracts/chatCanonicalMessage";
import { chatAttachmentIdentity } from "./identity";
import type { ChatAttachmentDisplay, ChatImageBlock } from "./types";

/** Merges image blocks without repeating identical payloads. */
export function mergeChatImages(
    previous: ChatImageBlock[] = [],
    next: ChatImageBlock[] = []
): ChatImageBlock[] {
    return mergeCanonicalChatImages(previous, next);
}

/** Merges attachment rows by their stable content identity. */
export function mergeChatAttachments(
    previous: ChatAttachmentDisplay[] = [],
    next: ChatAttachmentDisplay[] = []
): ChatAttachmentDisplay[] {
    const seenAttachments = new Set<string>();
    return [...previous, ...next].filter((attachment) => {
        const identity = chatAttachmentIdentity(attachment);
        if (seenAttachments.has(identity)) {
            return false;
        }
        seenAttachments.add(identity);
        return true;
    });
}
