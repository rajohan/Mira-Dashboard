import {
    type ChatRuntimeEvent,
    type ChatRuntimeState,
    completedChatRuns,
    reduceChatRuntime,
    isSameChatSession,
} from "./domain/chatState";
import type { ChatRuntimeSnapshot } from "./transport/chatTransport";

export function isLocallyOptimisticRunId(runId: string): boolean {
    return runId.startsWith("dashboard-chat-") || runId.startsWith("dashboard-compact-");
}

export interface SnapshotGate {
    events: ChatRuntimeEvent[];
    optimisticRuns: Map<
        string,
        {
            observedAfterSnapshotRequest: boolean;
            operation?: "compact";
            providerRunId?: string;
        }
    >;
    reconnecting: boolean;
    sessionKey: string;
    token: number;
}

export interface RuntimeIdentity {
    generation?: string;
    replayScope?: string;
}

export function replayIdentityTransition(
    previous: RuntimeIdentity,
    snapshot: Pick<ChatRuntimeSnapshot, "replayScope" | "runtimeGeneration">,
    isReconnecting: boolean
): { didLoseContinuity: boolean; isSameScopeRestart: boolean } {
    const didGenerationChange = Boolean(
        snapshot.runtimeGeneration &&
        previous.generation &&
        snapshot.runtimeGeneration !== previous.generation
    );
    const isKnownSameScope = Boolean(
        snapshot.replayScope &&
        previous.replayScope &&
        snapshot.replayScope === previous.replayScope
    );
    const didKnownScopeChange = Boolean(
        snapshot.replayScope &&
        previous.replayScope &&
        snapshot.replayScope !== previous.replayScope
    );
    return {
        didLoseContinuity:
            isReconnecting &&
            (didKnownScopeChange || (didGenerationChange && !isKnownSameScope)),
        isSameScopeRestart: isReconnecting && didGenerationChange && isKnownSameScope,
    };
}

export interface DisplacedReplayGroup {
    pendingRunIds: Set<string>;
    runs: ReturnType<typeof completedChatRuns>;
    sessionKey: string;
}

export function displacedReplayGroupForSession(
    groups: Map<string, DisplacedReplayGroup>,
    sessionKey: string
): [string, DisplacedReplayGroup] | undefined {
    for (const entry of groups) {
        if (isSameChatSession(entry[1].sessionKey, sessionKey)) return entry;
    }
    return undefined;
}

export type FinishEvent = Extract<ChatRuntimeEvent, { kind: "finish" }>;
export type ControlEvent = Extract<ChatRuntimeEvent, { kind: "control" }>;

interface RuntimeReduction {
    finishes: Array<{ event: FinishEvent; state: ChatRuntimeState }>;
    state: ChatRuntimeState;
}

export function reduceRuntimeEvents(
    previous: ChatRuntimeState,
    events: ChatRuntimeEvent[]
): RuntimeReduction {
    let state = previous;
    const finishes: RuntimeReduction["finishes"] = [];
    const orderedEvents = events.toSorted(
        (left, right) => left.sequence - right.sequence
    );
    for (const event of orderedEvents) {
        const next = reduceChatRuntime(state, [event]);
        if (next === state) continue;
        state = next;
        if (event.kind === "finish") finishes.push({ event, state });
    }
    return { finishes, state };
}

export function carryActiveRunsToGeneration(
    state: ChatRuntimeState,
    generation: number
): ChatRuntimeState {
    const sessions = Object.fromEntries(
        Object.entries(state.sessions).flatMap(([sessionKey, session]) => {
            const runs = Object.fromEntries(
                Object.entries(session.runs).flatMap(([runKey, run]) => {
                    if (run.phase !== "active") return [];
                    const retained = {
                        ...run,
                        commentary: [...run.commentary],
                        diagnostics: [...run.diagnostics],
                        lastSequence: -1,
                        userMessages: [...run.userMessages],
                    };
                    delete retained.terminalSequence;
                    return [[runKey, retained]];
                })
            );
            return Object.keys(runs).length > 0 || session.controls.length > 0
                ? [
                      [
                          sessionKey,
                          {
                              ...session,
                              controls: [...session.controls],
                              lastSequence: -1,
                              runs,
                          },
                      ],
                  ]
                : [];
        })
    );
    return { generation, sessions };
}
