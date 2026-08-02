import type { RefObject } from "react";

import {
    type DisplacedReplayGroup,
    displacedReplayGroupForSession,
    type SnapshotGate,
} from "./chatRuntimeReplay";
import {
    acknowledgeChatRun,
    addOptimisticChatRun,
    type ChatRuntimeState,
    clearChatRun,
    clearChatSessionRuntime,
    clearCompletedChatRuns,
    clearStatusOnlyChatRuns,
    completedChatRuns,
    isSameChatSession,
    restoreChatRuns,
} from "./domain/chatState";

export interface ChatRuntimeActions {
    acknowledgeRun: (
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ) => void;
    beginRun: (
        sessionKey: string,
        runId: string,
        options?: {
            operation?: "compact";
            replaceStatusOnlyRuns?: boolean;
        }
    ) => void;
    clearRun: (sessionKey: string, runId: string) => void;
    clearSession: (sessionKey: string) => void;
    failRun: (sessionKey: string, runId: string) => void;
}

interface ChatRuntimeActionContext {
    displacedCompletedRunsRef: RefObject<Map<string, DisplacedReplayGroup>>;
    gateRef: RefObject<SnapshotGate | undefined>;
    updateState: (
        update: (current: ChatRuntimeState) => ChatRuntimeState
    ) => ChatRuntimeState;
}

/**
 * Creates the imperative optimistic-run actions around shared runtime refs.
 * @param context Runtime state and replay-gate refs.
 * @returns Chat runtime actions.
 */
export function useChatRuntimeActions(
    context: ChatRuntimeActionContext
): ChatRuntimeActions {
    const { displacedCompletedRunsRef, gateRef, updateState } = context;

    const beginRun: ChatRuntimeActions["beginRun"] = (
        sessionKey,
        runId,
        options = {}
    ) => {
        const gate = gateRef.current;
        if (gate && isSameChatSession(gate.sessionKey, sessionKey)) {
            const pendingRun = gate.optimisticRuns.get(runId);
            gate.optimisticRuns.set(runId, {
                ...pendingRun,
                observedAfterSnapshotRequest: true,
                operation: options.operation ?? pendingRun?.operation,
            });
        }
        updateState((current) => {
            const existingGroup = displacedReplayGroupForSession(
                displacedCompletedRunsRef.current,
                sessionKey
            )?.[1];
            const displacedRuns = completedChatRuns(current, sessionKey);
            const group =
                existingGroup ||
                (Object.keys(displacedRuns).length > 0
                    ? {
                          pendingRunIds: new Set<string>(),
                          runs: displacedRuns,
                          sessionKey,
                      }
                    : undefined);
            if (group && !existingGroup) {
                displacedCompletedRunsRef.current.set(sessionKey, group);
            }
            group?.pendingRunIds.add(runId);
            const withoutStaleStatus = options.replaceStatusOnlyRuns
                ? clearStatusOnlyChatRuns(current, sessionKey)
                : current;
            return addOptimisticChatRun(
                clearCompletedChatRuns(withoutStaleStatus, sessionKey),
                sessionKey,
                runId,
                options.operation
            );
        });
    };

    const acknowledgeRun = (
        sessionKey: string,
        optimisticRunId: string,
        providerRunId?: string
    ) => {
        const displacedGroup = displacedReplayGroupForSession(
            displacedCompletedRunsRef.current,
            sessionKey
        );
        if (displacedGroup?.[1].pendingRunIds.has(optimisticRunId)) {
            displacedCompletedRunsRef.current.delete(displacedGroup[0]);
        }
        const gate = gateRef.current;
        const pendingRun =
            gate && isSameChatSession(gate.sessionKey, sessionKey)
                ? gate.optimisticRuns.get(optimisticRunId)
                : undefined;
        if (pendingRun) {
            pendingRun.observedAfterSnapshotRequest = true;
            pendingRun.providerRunId = providerRunId;
        }
        updateState((current) =>
            acknowledgeChatRun(current, sessionKey, optimisticRunId, providerRunId)
        );
    };

    const removeRunFromSnapshotGate = (sessionKey: string, runId: string) => {
        const gate = gateRef.current;
        if (gate && isSameChatSession(gate.sessionKey, sessionKey)) {
            for (const [optimisticRunId, pendingRun] of gate.optimisticRuns) {
                if (optimisticRunId === runId || pendingRun.providerRunId === runId) {
                    gate.optimisticRuns.delete(optimisticRunId);
                }
            }
        }
    };

    const clearRun = (sessionKey: string, runId: string) => {
        const displacedGroup = displacedReplayGroupForSession(
            displacedCompletedRunsRef.current,
            sessionKey
        );
        if (displacedGroup?.[1].pendingRunIds.has(runId)) {
            displacedCompletedRunsRef.current.delete(displacedGroup[0]);
        }
        removeRunFromSnapshotGate(sessionKey, runId);
        updateState((current) => clearChatRun(current, sessionKey, runId));
    };

    const failRun = (sessionKey: string, runId: string) => {
        removeRunFromSnapshotGate(sessionKey, runId);
        const displacedGroup = displacedReplayGroupForSession(
            displacedCompletedRunsRef.current,
            sessionKey
        );
        const displaced = displacedGroup?.[1];
        const didRemovePendingRun = displaced?.pendingRunIds.delete(runId) === true;
        const shouldRestore = didRemovePendingRun && displaced?.pendingRunIds.size === 0;
        if (displacedGroup && shouldRestore) {
            displacedCompletedRunsRef.current.delete(displacedGroup[0]);
        }
        updateState((current) => {
            const withoutFailedRun = clearChatRun(current, sessionKey, runId);
            return shouldRestore && displaced
                ? restoreChatRuns(withoutFailedRun, sessionKey, displaced.runs)
                : withoutFailedRun;
        });
    };

    const clearSession = (sessionKey: string) => {
        if (isSameChatSession(gateRef.current?.sessionKey, sessionKey)) {
            gateRef.current = undefined;
        }
        for (const [groupKey, displaced] of displacedCompletedRunsRef.current) {
            if (isSameChatSession(displaced.sessionKey, sessionKey)) {
                displacedCompletedRunsRef.current.delete(groupKey);
            }
        }
        updateState((current) => clearChatSessionRuntime(current, sessionKey));
    };

    return { acknowledgeRun, beginRun, clearRun, clearSession, failRun };
}
