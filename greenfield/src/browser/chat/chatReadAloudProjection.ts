import type { ChatDisplayMessage } from "./chatTypes.ts";

function messageRunIds(message: ChatDisplayMessage): readonly string[] {
    return [message.runId, message.clientRunId, message.providerRunId].filter(
        (runId): runId is string => runId !== undefined
    );
}

export function activeStreamingTextMessageIds(
    messages: readonly ChatDisplayMessage[],
    activeRunIds: readonly string[]
): ReadonlySet<string> {
    const active = new Set(activeRunIds);
    const latestByRunId = new Map<string, string>();
    for (const message of messages) {
        if (
            message.role !== "assistant" ||
            !message.parts.some((part) => part.kind === "text")
        ) {
            continue;
        }
        for (const runId of messageRunIds(message)) {
            if (active.has(runId)) latestByRunId.set(runId, message.id);
        }
    }
    return new Set(latestByRunId.values());
}
