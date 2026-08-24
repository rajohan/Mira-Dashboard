import type { ChatDisplayMessage } from "./chatTypes.ts";

function compareExactStrings(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function chronologicalMessageOrder(
    left: ChatDisplayMessage,
    right: ChatDisplayMessage
): number {
    const leftUsesFallback = left.timestampMs === undefined;
    const rightUsesFallback = right.timestampMs === undefined;
    if (leftUsesFallback !== rightUsesFallback) return leftUsesFallback ? 1 : -1;
    return (
        (left.timestampMs ?? 0) - (right.timestampMs ?? 0) ||
        left.sequence - right.sequence ||
        compareExactStrings(left.id, right.id)
    );
}

function messageOrderGroup(message: ChatDisplayMessage): string {
    return message.providerRunId === undefined
        ? `message:${message.id}`
        : `provider-run:${message.providerRunId}`;
}

/**
 * Sorts provider-run rows as one stable causal group among ordinary messages.
 * @param messages Runtime or merged transcript rows.
 * @returns A deterministic chronological copy with provider sequence preserved per run.
 */
export function sortChatDisplayMessages(
    messages: readonly ChatDisplayMessage[]
): readonly ChatDisplayMessage[] {
    const groupOrder = new Map<string, ChatDisplayMessage>();
    for (const message of messages) {
        const group = messageOrderGroup(message);
        const previous = groupOrder.get(group);
        if (previous === undefined || chronologicalMessageOrder(message, previous) < 0) {
            groupOrder.set(group, message);
        }
    }
    return [...messages].toSorted((left, right) => {
        const leftGroup = messageOrderGroup(left);
        const rightGroup = messageOrderGroup(right);
        if (leftGroup === rightGroup && left.providerRunId !== undefined) {
            return (
                left.sequence - right.sequence || compareExactStrings(left.id, right.id)
            );
        }
        const leftOrder = groupOrder.get(leftGroup) ?? left;
        const rightOrder = groupOrder.get(rightGroup) ?? right;
        return (
            chronologicalMessageOrder(leftOrder, rightOrder) ||
            compareExactStrings(leftGroup, rightGroup)
        );
    });
}
