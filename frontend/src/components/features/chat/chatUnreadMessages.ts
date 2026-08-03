import type { ChatRow } from "./chatTypes";
import { hasPrimaryAnswerContent } from "./domain/chatAnswerContent";

export type ChatUnreadMessageIdentity = readonly string[];

function isConversationMessageRow(row: ChatRow): boolean {
    const role = row.message.role.toLowerCase();
    return (
        (row.kind === "message" || row.kind === "stream") &&
        (role === "assistant" || role === "system" || role === "user") &&
        hasPrimaryAnswerContent(row.message)
    );
}

/**
 * Captures each visible conversation row through every stable identity alias.
 * Delete identities survive runtime-to-history reconciliation when row keys change.
 * @param rows Projected chat rows.
 * @returns Stable identity aliases for visible conversation rows.
 */
export function chatUnreadMessageIdentities(
    rows: ChatRow[]
): ChatUnreadMessageIdentity[] {
    return rows.flatMap((row) =>
        isConversationMessageRow(row)
            ? [
                  [
                      ...new Set([
                          row.key,
                          ...(row.identityKeys ?? []),
                          ...(row.deleteKeys ?? []),
                      ]),
                  ],
              ]
            : []
    );
}

/**
 * Counts genuinely new conversation rows without recounting reconciled aliases.
 * @param previousIdentities Identities from the previous projection.
 * @param currentIdentities Identities from the current projection.
 * @returns Number of genuinely added conversation rows.
 */
export function countAddedChatUnreadMessages(
    previousIdentities: ChatUnreadMessageIdentity[],
    currentIdentities: ChatUnreadMessageIdentity[]
): number {
    const previousIndexesByAlias = new Map<string, number[]>();
    for (const [index, aliases] of previousIdentities.entries()) {
        for (const alias of aliases) {
            const indexes = previousIndexesByAlias.get(alias) ?? [];
            indexes.push(index);
            previousIndexesByAlias.set(alias, indexes);
        }
    }

    const matchedPreviousIndexes = new Set<number>();
    let addedCount = 0;
    for (const aliases of currentIdentities) {
        const matchingPreviousIndex = aliases
            .flatMap((alias) => previousIndexesByAlias.get(alias) ?? [])
            .find((index) => !matchedPreviousIndexes.has(index));
        if (matchingPreviousIndex === undefined) {
            addedCount += 1;
        } else {
            matchedPreviousIndexes.add(matchingPreviousIndex);
        }
    }
    return addedCount;
}
