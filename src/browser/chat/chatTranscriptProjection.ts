import { chatToolActivityText } from "./chatToolPresentation.ts";
import type { ChatDisplayMessage } from "./chatTypes.ts";

export const activeCompactionMaximumAgeMs = 5 * 60_000;
export const completedCompactionMaximumAgeMs = 15_000;

function messageMatchesActiveRun(
    message: ChatDisplayMessage,
    activeRunId: string
): boolean {
    return (
        message.runId === activeRunId ||
        message.clientRunId === activeRunId ||
        message.providerRunId === activeRunId
    );
}

function retainedCompactionMessages(
    messages: readonly ChatDisplayMessage[],
    nowMs: number
): readonly ChatDisplayMessage[] {
    return messages.filter((message) => {
        const compaction = message.parts.find(
            (part) => part.kind === "control" && part.activity !== undefined
        );
        if (compaction?.kind !== "control" || compaction.activity === undefined) {
            return true;
        }
        if (message.timestampMs === undefined) return false;
        const maximumAge =
            compaction.activity === "running"
                ? activeCompactionMaximumAgeMs
                : completedCompactionMaximumAgeMs;
        return nowMs - message.timestampMs < maximumAge;
    });
}

function withActiveChatActivity(
    messages: readonly ChatDisplayMessage[],
    activeRunIds: readonly string[],
    sessionKey: string
): readonly ChatDisplayMessage[] {
    const activeRunId = activeRunIds.at(-1);
    if (activeRunId === undefined) return messages;

    const candidates = messages.filter((message) =>
        messageMatchesActiveRun(message, activeRunId)
    );
    const latestUserIndex = candidates.findLastIndex(
        (message) => message.role === "user"
    );
    const assistantCandidates = candidates
        .slice(latestUserIndex + 1)
        .filter((message) => message.role === "assistant");
    const activitySource = assistantCandidates.at(-1);
    if (
        candidates.some((message) =>
            message.parts.some(
                (part) => part.kind === "control" && part.activity === "running"
            )
        ) ||
        activitySource?.parts.some(
            (part) => part.kind === "text" && part.text.trim() !== ""
        )
    ) {
        return messages;
    }

    const latestPart = activitySource?.parts.at(-1);
    const text =
        latestPart?.kind === "tool" ? chatToolActivityText(latestPart) : "Thinking…";
    return [
        ...messages,
        {
            attachments: [],
            id: `activity:${activeRunId}`,
            parts: [
                {
                    activity: "running",
                    kind: "control",
                    text,
                    tone: "muted",
                },
            ],
            role: "assistant",
            sequence: Number.MAX_SAFE_INTEGER,
            sessionKey,
        },
    ];
}

/**
 * Projects bounded compaction feedback and one trailing live activity row.
 * @param messages Canonical and provider-runtime transcript rows.
 * @param activeRunIds Authoritative currently active run identities.
 * @param sessionKey Current chat session identity.
 * @param nowMs Clock used only for the bounded compaction lifecycle.
 * @returns Rows in the exact order consumed by visibility filtering and virtualization.
 */
export function projectChatTranscriptMessages(
    messages: readonly ChatDisplayMessage[],
    activeRunIds: readonly string[],
    sessionKey: string,
    nowMs: number
): readonly ChatDisplayMessage[] {
    return withActiveChatActivity(
        retainedCompactionMessages(messages, nowMs),
        activeRunIds,
        sessionKey
    );
}
