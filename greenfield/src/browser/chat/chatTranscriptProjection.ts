import { chatToolActivityText } from "./chatToolPresentation.ts";
import type { ChatDisplayMessage } from "./chatTypes.ts";

export const activeCompactionMaximumAgeMs = 5 * 60_000;
export const completedCompactionMaximumAgeMs = 5000;

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
    const activityAfterMessage = new Map<string, ChatDisplayMessage[]>();
    const trailingActivity: ChatDisplayMessage[] = [];
    const emittedTargets = new Set<string>();
    for (const activeRunId of activeRunIds) {
        const candidates = messages.filter((message) =>
            messageMatchesActiveRun(message, activeRunId)
        );
        const target = candidates.at(-1);
        const latestUserIndex = candidates.findLastIndex(
            (message) => message.role === "user"
        );
        const assistantCandidates = candidates
            .slice(latestUserIndex + 1)
            .filter((message) => message.role === "assistant");
        const activitySource = assistantCandidates.at(-1);
        if (
            (target !== undefined && emittedTargets.has(target.id)) ||
            candidates.some((message) =>
                message.parts.some(
                    (part) => part.kind === "control" && part.activity === "running"
                )
            ) ||
            activitySource?.parts.some(
                (part) => part.kind === "text" && part.text.trim() !== ""
            )
        ) {
            continue;
        }
        if (target !== undefined) emittedTargets.add(target.id);
        const latestPart = activitySource?.parts.at(-1);
        const text =
            latestPart?.kind === "tool" ? chatToolActivityText(latestPart) : "Thinking…";
        const identity =
            latestPart?.kind === "tool" ? `tool:${latestPart.callId}` : "thinking";
        const activity: ChatDisplayMessage = {
            attachments: [],
            id: `activity:${activeRunId}:${identity}`,
            parts: [
                {
                    activity: "running",
                    kind: "control",
                    text,
                    tone: "muted",
                },
            ],
            role: "assistant",
            sequence: target?.sequence ?? Number.MAX_SAFE_INTEGER,
            sessionKey: target?.sessionKey ?? sessionKey,
            ...(target?.timestampMs === undefined
                ? {}
                : { timestampMs: target.timestampMs }),
        };
        if (target === undefined) {
            trailingActivity.push(activity);
        } else {
            activityAfterMessage.set(target.id, [
                ...(activityAfterMessage.get(target.id) ?? []),
                activity,
            ]);
        }
    }
    return [
        ...messages.flatMap((message) => [
            message,
            ...(activityAfterMessage.get(message.id) ?? []),
        ]),
        ...trailingActivity,
    ];
}

/**
 * Projects bounded compaction feedback and one live activity row per active run.
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
