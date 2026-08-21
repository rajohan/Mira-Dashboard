import {
    type InfiniteData,
    type QueryKey,
    useInfiniteQuery,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { useStore } from "@tanstack/react-store";
import { useEffect, useRef, useState } from "react";

import type {
    ChatCompanionStateOutput,
    ChatHistoryOutput,
} from "../../contracts/chat.ts";
import {
    gatewaySessionAgentId,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import type {
    OpenClawTaskCancelOutput,
    OpenClawTaskGetOutput,
    OpenClawTaskListOutput,
    OpenClawTaskSummary,
} from "../../contracts/openClawTasks.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    classifyDashboardBrowserFailure,
    dashboardBrowserFailureMessage,
    isDashboardOperationOutcomeUnknown,
} from "../api/trpcError.ts";
import { authenticatedAbortSignal } from "../auth/authenticatedOperationRegistry.ts";
import {
    AuthenticatedMutationExpiredError,
    useAuthenticatedMutationBoundary,
} from "../auth/useAuthenticatedMutationBoundary.ts";
import { workspaceFileClient } from "../files/workspaceFileClient.ts";
import {
    gatewaySessionQueryKey,
    gatewaySessionQueryOptions,
} from "../sessions/gatewaySessionQueries.ts";
import {
    createChatDraftAttachments,
    validateChatAttachmentFiles,
} from "./chatAttachments.ts";
import {
    chatAbortControlsAreEnabled,
    chatAbortIsGated,
    type ChatAbortGate,
    chatSendIsEnabled,
    type ChatTaskCancelGate,
    chatTaskCancelIsGated,
    reconcileChatTaskSummary,
} from "./chatInteractionState.ts";
import {
    readChatDisplaySettings,
    writeChatDisplaySettings,
} from "./chatLocalPreferences.ts";
import {
    createChatIdempotencyKey,
    chatSendFailureDisposition,
    createChatSendIdentity,
    executeChatSend,
} from "./chatMutations.ts";
import {
    type ChatCompanionResetObservationBoundary,
    type ChatProviderObservationBoundary,
    chatCompanionResetObservationConfirmsReset,
    chatCompanionStateFingerprint,
    chatProviderObservationIsNewer,
    chatRuntimeObservationAdvancesRun,
    chatTaskObservationAdvances,
} from "./chatPostMutationObservations.ts";
import {
    type ChatRuntimeBatch,
    chatCompanionQueryKey,
    chatCompanionQueryOptions,
    chatHistoryQueryKey,
    chatHistoryQueryOptions,
    chatMessageQueryOptions,
    chatModelsQueryOptions,
    chatRuntimeQueryKey,
    mergeOpenClawTaskProjectionPages,
    openClawTaskDetailQueryKey,
    openClawTaskDetailQueryOptions,
    openClawTaskListQueryKey,
    openClawTaskListQueryOptions,
    openClawTaskListSessionQueryKey,
    projectChatCompanion,
    projectOpenClawTask,
    readChatRuntimeBatch,
    retainAuthoritativeHistoryWindow,
} from "./chatQueries.ts";
import { resolveChatSessionKey } from "./chatRouteSearch.ts";
import { useChatRuntimeStore } from "./chatRuntimeContextValue.ts";
import {
    type ChatExternalRunProjection,
    chatRuntimeMessages,
    chatRuntimePlans,
} from "./chatRuntimeStore.ts";
import type {
    ChatDisplaySettings,
    ChatDraftAttachment,
    ChatOptimisticAttachment,
    ChatSendSettings,
    ChatWorkspaceView,
} from "./chatTypes.ts";
import {
    mergeChatMessages,
    projectChatHistory,
    projectChatMessageSurfaces,
    projectChatSessions,
    runtimeMessagesWithinCanonicalWindow,
} from "./chatViewProjection.ts";
import { ChatWorkspace } from "./ChatWorkspace.tsx";
import { useChatRealtimeInvalidation } from "./useChatRealtimeInvalidation.ts";
import {
    applyChatRuntimeBatch,
    useChatRuntimeProjection,
} from "./useChatRuntimeProjection.ts";
import { useChatSpeech } from "./useChatSpeech.ts";

interface SessionDraft {
    readonly attachmentError?: string;
    readonly attachments: readonly ChatDraftAttachment[];
    readonly text: string;
    readonly version: number;
}

interface CompanionOperationGateBase {
    readonly generation: number;
    readonly ownerIsActive: () => boolean;
}

interface CompanionAskGate extends CompanionOperationGateBase {
    readonly exchangeBoundaryMs: number;
    readonly kind: "ask";
    readonly question: string;
}

interface CompanionResetGate extends CompanionOperationGateBase {
    readonly kind: "reset";
    readonly observationBoundary: ChatCompanionResetObservationBoundary;
}

type CompanionOperationGate = CompanionAskGate | CompanionResetGate;

interface ProviderControlGate extends ChatProviderObservationBoundary {
    readonly generation: number;
    readonly sessionKey: string;
}

interface ExternalAbortGate {
    readonly attemptId: string;
    readonly sessionKey: string;
}

interface ProviderObservedMutationResult<TResult> {
    readonly gate: ProviderControlGate;
    readonly observation?: ListGatewaySessionsResult;
    readonly observationError?: unknown;
    readonly outcomeError?: unknown;
    readonly output?: TResult;
    readonly ownerIsActive: () => boolean;
}

interface TaskPostMutationObservation {
    readonly absent: boolean;
    readonly task?: OpenClawTaskSummary;
}

const externalRunControlPrefix = "provider-run:";

function externalRunControlId(providerRunId: string): string {
    return `${externalRunControlPrefix}${providerRunId}`;
}

function providerRunIdFromControlId(controlId: string): string | undefined {
    return controlId.startsWith(externalRunControlPrefix)
        ? controlId.slice(externalRunControlPrefix.length)
        : undefined;
}

function externalAbortBoundaryIsGated(run: ChatExternalRunProjection): boolean {
    const boundary = run.abortBoundary;
    return (
        boundary !== undefined &&
        boundary.settlement !== "not-aborted" &&
        (boundary.settlement === "pending" ||
            run.observationEpoch <= boundary.baselineObservationEpoch ||
            run.observedAtMs <= boundary.attemptedAtMs ||
            run.updatedAtMs <= boundary.baselineUpdatedAtMs)
    );
}

function emptyDraft(): SessionDraft {
    return { attachments: [], text: "", version: 0 };
}

function effectiveChatSpeed(
    fastMode: ChatSendSettings["fastMode"] | null,
    fallback: ChatSendSettings["speed"]
): ChatSendSettings["speed"] {
    if (fastMode === true) return "fast";
    if (fastMode === false) return "standard";
    return fallback;
}

function inactiveCompanionOperation(): boolean {
    return false;
}

function assertAuthenticatedMutationOwner(isActive: () => boolean): void {
    if (!isActive()) throw new AuthenticatedMutationExpiredError();
}

function companionOperationView(
    current: ChatWorkspaceView["companion"],
    status: "error" | "resetting",
    error?: string
): ChatWorkspaceView["companion"] {
    return {
        ...(current.answer === undefined ? {} : { answer: current.answer }),
        ...(error === undefined ? {} : { error }),
        ...(current.question === undefined ? {} : { question: current.question }),
        status,
    };
}

function chatConnectionState(
    sourceFresh: boolean,
    runtimeFailed: boolean,
    runtimeConnection: ChatWorkspaceView["connection"]
): ChatWorkspaceView["connection"] {
    if (!sourceFresh) return "stale";
    if (runtimeFailed) return "disconnected";
    return runtimeConnection;
}

function chatQueryError(
    input: Readonly<{
        actionError?: string;
        historyFailed: boolean;
        runtimeFailed: boolean;
        sessionsError: unknown;
        sessionsMissing: boolean;
    }>
): string | undefined {
    if (input.sessionsMissing && input.sessionsError !== null) {
        return dashboardBrowserFailureMessage(input.sessionsError);
    }
    if (input.sessionsError !== null || input.historyFailed) {
        return "Some chat data could not be updated. The latest available messages remain visible.";
    }
    if (input.runtimeFailed) {
        return "Live updates are unavailable. Drafts remain saved in this browser.";
    }
    return input.actionError;
}

interface ChatBrowserProps {
    readonly onSelectedSessionChange: (sessionKey: string) => void;
    readonly requestedSessionKey?: string;
}

interface SessionSelectionNormalizationProps {
    readonly onSelectedSessionChange: (sessionKey: string) => void;
    readonly requestIdentity: string;
    readonly selectedSessionKey: string;
}

function SessionSelectionNormalization({
    onSelectedSessionChange,
    requestIdentity,
    selectedSessionKey,
}: SessionSelectionNormalizationProps) {
    const [normalizedRequest, setNormalizedRequest] = useState<string>();

    function normalizeSelection(element: HTMLSpanElement | null): void {
        if (element === null || normalizedRequest === requestIdentity) return;
        setNormalizedRequest(requestIdentity);
        onSelectedSessionChange(selectedSessionKey);
    }

    return <span hidden ref={normalizeSelection} />;
}

/**
 * Stateful production composition for the URL-addressable `/chat` workspace.
 * @returns The complete chat browser.
 */
export function ChatBrowser({
    onSelectedSessionChange,
    requestedSessionKey,
}: ChatBrowserProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const runtimeStore = useChatRuntimeStore();
    const runtimeState = useStore(runtimeStore, (state) => state);
    const sessionsQuery = useQuery(gatewaySessionQueryOptions(client));
    const sessionsWithoutModels =
        sessionsQuery.data === undefined
            ? []
            : projectChatSessions(sessionsQuery.data, undefined);
    const inventoryCanResolveMissingRequest =
        sessionsQuery.data?.source.freshness === "fresh" &&
        !sessionsQuery.data.projectionTruncated;
    const preliminarySessionKey = resolveChatSessionKey(
        requestedSessionKey,
        sessionsWithoutModels,
        inventoryCanResolveMissingRequest
    );
    const selectedAgentId = gatewaySessionAgentId(preliminarySessionKey) ?? "";
    const modelsQuery = useQuery(chatModelsQueryOptions(client, selectedAgentId));
    const sessions =
        sessionsQuery.data === undefined
            ? []
            : projectChatSessions(sessionsQuery.data, modelsQuery.data);
    const selectedSessionKey = resolveChatSessionKey(
        preliminarySessionKey,
        sessions,
        inventoryCanResolveMissingRequest
    );
    const selectedSession = sessions.find(({ key }) => key === selectedSessionKey);
    const [drafts, setDrafts] = useState<Readonly<Record<string, SessionDraft>>>({});
    const [displaySettings, setDisplaySettings] = useState<ChatDisplaySettings>(
        readChatDisplaySettings
    );
    const [sendSettings, setSendSettings] = useState<
        Readonly<Record<string, ChatSendSettings>>
    >({});
    const [selectedTasks, setSelectedTasks] = useState<Readonly<Record<string, string>>>(
        {}
    );
    const [taskOverrides, setTaskOverrides] = useState<
        Readonly<Record<string, OpenClawTaskSummary>>
    >({});
    const [absentTaskIds, setAbsentTaskIds] = useState<ReadonlySet<string>>(new Set());
    const [hydrationTarget, setHydrationTarget] =
        useState<Readonly<{ messageId: string; sessionKey: string }>>();
    const [companionOverride, setCompanionOverride] = useState<
        Readonly<Record<string, ChatWorkspaceView["companion"]>>
    >({});
    const [companionGates, setCompanionGates] = useState<
        Readonly<Record<string, CompanionOperationGate>>
    >({});
    const companionGenerations = useRef<Readonly<Record<string, number>>>({});
    const companionAskControllers = useRef(new Map<string, AbortController>());
    const companionAskLocks = useRef(new Set<string>());
    const companionResetLocks = useRef(new Set<string>());
    const [pendingActions, setPendingActions] = useState(0);
    const [actionError, setActionError] = useState<string>();
    const [actionNotice, setActionNotice] = useState<string>();
    const [providerControlGate, setProviderControlGate] = useState<ProviderControlGate>();
    const providerControlGeneration = useRef(0);
    const providerControlLock = useRef(false);
    const [abortGates, setAbortGates] = useState<Readonly<Record<string, ChatAbortGate>>>(
        {}
    );
    const [externalAbortGates, setExternalAbortGates] = useState<
        Readonly<Record<string, ExternalAbortGate>>
    >({});
    const abortLocks = useRef(new Set<string>());
    const externalAbortLocks = useRef(new Map<string, ExternalAbortGate>());
    const [taskCancelGates, setTaskCancelGates] = useState<
        Readonly<Record<string, ChatTaskCancelGate>>
    >({});
    const taskCancelLocks = useRef(new Set<string>());
    const olderHistoryLoad = useRef<Promise<boolean> | undefined>(undefined);
    const [olderHistoryLoading, setOlderHistoryLoading] = useState(false);

    useChatRealtimeInvalidation(selectedSessionKey, runtimeStore);
    const runtimeQuery = useChatRuntimeProjection(
        client,
        selectedSessionKey,
        runtimeStore
    );
    const historyQuery = useInfiniteQuery(
        chatHistoryQueryOptions(client, selectedSessionKey)
    );
    const companionQuery = useQuery(
        chatCompanionQueryOptions(client, selectedSessionKey)
    );
    const activeTasksQuery = useInfiniteQuery(
        openClawTaskListQueryOptions(client, selectedSessionKey, "active")
    );
    const finishedTasksQuery = useInfiniteQuery(
        openClawTaskListQueryOptions(client, selectedSessionKey, "finished")
    );
    const taskRows = mergeOpenClawTaskProjectionPages(
        activeTasksQuery.data,
        finishedTasksQuery.data
    ).filter((task) => !absentTaskIds.has(task.id));
    const retainedTaskRows = Object.keys(taskCancelGates).flatMap((taskId) => {
        if (taskRows.some((task) => task.id === taskId)) return [];
        const retained = taskOverrides[taskId];
        return retained === undefined ? [] : [retained];
    });
    const requestedTaskId = selectedTasks[selectedSessionKey];
    const taskDetailQuery = useQuery(
        openClawTaskDetailQueryOptions(client, requestedTaskId)
    );
    useEffect(() => {
        if (
            requestedTaskId === undefined ||
            taskDetailQuery.error === null ||
            classifyDashboardBrowserFailure(taskDetailQuery.error) !== "not-found"
        ) {
            return;
        }
        let disposed = false;
        queueMicrotask(() => {
            if (disposed) return;
            taskCancelLocks.current.delete(requestedTaskId);
            setTaskCancelGates((current) => {
                if (current[requestedTaskId] === undefined) return current;
                const next = { ...current };
                delete next[requestedTaskId];
                return next;
            });
            setTaskOverrides((current) => {
                if (current[requestedTaskId] === undefined) return current;
                const next = { ...current };
                delete next[requestedTaskId];
                return next;
            });
            setAbsentTaskIds((current) =>
                current.has(requestedTaskId)
                    ? current
                    : new Set([...current, requestedTaskId])
            );
            setSelectedTasks((current) => {
                if (current[selectedSessionKey] !== requestedTaskId) return current;
                const next = { ...current };
                delete next[selectedSessionKey];
                return next;
            });
            queryClient.removeQueries({
                exact: true,
                queryKey: openClawTaskDetailQueryKey(requestedTaskId),
            });
        });
        return () => {
            disposed = true;
        };
    }, [queryClient, requestedTaskId, selectedSessionKey, taskDetailQuery.error]);
    const selectedDetail = taskDetailQuery.data?.task;
    const retainedSelectedDetail =
        selectedDetail === undefined ||
        absentTaskIds.has(selectedDetail.id) ||
        taskRows.some((task) => task.id === selectedDetail.id) ||
        retainedTaskRows.some((task) => task.id === selectedDetail.id)
            ? []
            : [selectedDetail];
    const selectableTaskRows = [
        ...taskRows,
        ...retainedTaskRows,
        ...retainedSelectedDetail,
    ];
    const selectedTaskId = selectableTaskRows.some((task) => task.id === requestedTaskId)
        ? requestedTaskId
        : undefined;
    const hydratedMessageQuery = useQuery(
        chatMessageQueryOptions(
            client,
            selectedSessionKey,
            hydrationTarget?.sessionKey === selectedSessionKey
                ? hydrationTarget.messageId
                : undefined
        )
    );

    useEffect(() => {
        queryClient.setQueryData<InfiniteData<ChatHistoryOutput>>(
            chatHistoryQueryKey(selectedSessionKey),
            retainAuthoritativeHistoryWindow
        );
    }, [historyQuery.data, queryClient, selectedSessionKey]);

    let hydrationStatus: "error" | "loading" | undefined;
    if (hydratedMessageQuery.isPending && hydrationTarget !== undefined) {
        hydrationStatus = "loading";
    } else if (hydratedMessageQuery.error !== null) {
        hydrationStatus = "error";
    }
    const historyMessages = projectChatHistory(historyQuery.data, selectedSessionKey, {
        ...(hydrationTarget?.sessionKey === selectedSessionKey
            ? { messageId: hydrationTarget.messageId }
            : {}),
        ...(hydratedMessageQuery.data === undefined
            ? {}
            : { detail: hydratedMessageQuery.data }),
        ...(hydrationStatus === undefined ? {} : { status: hydrationStatus }),
    });
    const activeRuntimeIdentities = new Set([
        ...Object.entries(runtimeState.sessions[selectedSessionKey]?.runs ?? {}).flatMap(
            ([runId, run]) => (run.phase === "active" ? [runId] : [])
        ),
        ...Object.entries(
            runtimeState.sessions[selectedSessionKey]?.externalRuns ?? {}
        ).flatMap(([providerRunId, run]) =>
            run.lifecycle === "active" ? [providerRunId] : []
        ),
    ]);
    const runtimeMessages = runtimeMessagesWithinCanonicalWindow(
        chatRuntimeMessages(runtimeState, selectedSessionKey),
        historyMessages,
        historyQuery.hasNextPage,
        activeRuntimeIdentities
    );
    const messages = projectChatMessageSurfaces(
        mergeChatMessages(historyMessages, runtimeMessages)
    );

    useEffect(() => {
        const canonicalMessages = projectChatHistory(
            historyQuery.data,
            selectedSessionKey
        );
        runtimeStore.reconcileHistory(selectedSessionKey, {
            clientRunIds: canonicalMessages.flatMap((message) =>
                message.clientRunId === undefined ? [] : [message.clientRunId]
            ),
            idempotencyKeys: canonicalMessages.flatMap((message) =>
                message.idempotencyKey === undefined ? [] : [message.idempotencyKey]
            ),
            runIds: canonicalMessages.flatMap((message) =>
                message.role !== "assistant" || message.runId === undefined
                    ? []
                    : [message.runId]
            ),
            providerRunIds: canonicalMessages.flatMap((message) =>
                message.role !== "assistant" || message.providerRunId === undefined
                    ? []
                    : [message.providerRunId]
            ),
            throughCursor: runtimeStore.cursorFor(selectedSessionKey),
        });
    }, [historyQuery.data, runtimeStore, selectedSessionKey]);

    const authoritativeTasks = selectableTaskRows.map((task) =>
        reconcileChatTaskSummary(
            task,
            selectedDetail?.id === task.id ? selectedDetail : undefined
        )
    );
    const tasks = authoritativeTasks.map((task) => {
        const current = reconcileChatTaskSummary(task, taskOverrides[task.id]);
        return projectOpenClawTask(
            current,
            selectedDetail?.id === current.id ? selectedDetail : undefined
        );
    });
    const companion =
        companionOverride[selectedSessionKey] ??
        projectChatCompanion(companionQuery.data?.exchanges);

    const currentDraft = drafts[selectedSessionKey] ?? emptyDraft();
    const speech = useChatSpeech({
        draft: currentDraft.text,
        onChangeDraft: (text) =>
            updateDraft(selectedSessionKey, (draft) => ({
                ...draft,
                text,
                version: draft.version + 1,
            })),
        sessionKey: selectedSessionKey,
    });
    const currentDisplay = displaySettings;
    const providerSendSettings: ChatSendSettings = {
        ...(selectedSession?.fastMode === undefined
            ? {}
            : { fastMode: selectedSession.fastMode }),
        ...(selectedSession?.model === undefined ? {} : { model: selectedSession.model }),
        speed: selectedSession?.speed ?? "standard",
        ...(selectedSession?.thinking === undefined
            ? {}
            : { thinking: selectedSession.thinking }),
    };
    const currentSendSettings: ChatSendSettings =
        providerControlGate === undefined
            ? providerSendSettings
            : (sendSettings[selectedSessionKey] ?? providerSendSettings);
    const runtimeSession = runtimeState.sessions[selectedSessionKey];
    const localActiveRunIds = Object.entries(runtimeSession?.runs ?? {})
        .filter(([, run]) => run.phase === "active")
        .map(([runId]) => runId);
    const externalActiveRunIds = Object.entries(runtimeSession?.externalRuns ?? {})
        .filter(([, run]) => run.continuity === "complete" && run.lifecycle === "active")
        .map(([providerRunId]) => providerRunId);
    const allActiveRunIds = [...localActiveRunIds, ...externalActiveRunIds];
    const activeRunIds = [
        ...localActiveRunIds.filter(
            (runId) =>
                !chatAbortIsGated(
                    abortGates[runId],
                    selectedSessionKey,
                    runtimeSession?.runs[runId]
                )
        ),
        ...externalActiveRunIds.flatMap((providerRunId) => {
            const controlId = externalRunControlId(providerRunId);
            const gate = externalAbortGates[controlId];
            const externalRun = runtimeSession?.externalRuns[providerRunId];
            const abortBoundary = externalRun?.abortBoundary;
            return externalRun !== undefined &&
                (externalAbortBoundaryIsGated(externalRun) ||
                    (gate?.sessionKey === selectedSessionKey &&
                        abortBoundary?.attemptId !== gate.attemptId))
                ? []
                : [controlId];
        }),
    ];
    const taskCancelGatedIds = authoritativeTasks.flatMap((task) =>
        chatTaskCancelIsGated(taskCancelGates[task.id]) ? [task.id] : []
    );

    const sourceFresh =
        selectedSessionKey !== "" &&
        sessionsQuery.data?.source.freshness === "fresh" &&
        sessionsQuery.error === null;
    const connection = chatConnectionState(
        sourceFresh,
        runtimeQuery.error !== null,
        runtimeState.connection
    );
    const actionBusy = pendingActions > 0 || providerControlGate !== undefined;
    const providerWritesDisabled = !sourceFresh || connection !== "connected";
    const providerWritesEnabled = !providerWritesDisabled && !actionBusy;
    const canSend = chatSendIsEnabled({
        actionBusy,
        attachments: currentDraft.attachments,
        connection,
        sessionKey: selectedSessionKey,
        sourceFresh,
        text: currentDraft.text,
    });
    const stopControlsEnabled = chatAbortControlsAreEnabled({
        actionBusy,
        connection,
        sourceFresh,
    });
    const abortableRunId = stopControlsEnabled ? activeRunIds.at(-1) : undefined;

    function updateDraft(
        sessionKey: string,
        update: (draft: SessionDraft) => SessionDraft
    ): void {
        if (sessionKey === "") return;
        setDrafts((current) => ({
            ...current,
            [sessionKey]: update(current[sessionKey] ?? emptyDraft()),
        }));
    }

    function releaseProviderControl(generation: number): void {
        if (providerControlGeneration.current !== generation) return;
        providerControlLock.current = false;
        setProviderControlGate((current) =>
            current?.generation === generation ? undefined : current
        );
    }

    function acceptProviderObservation(
        gate: ProviderControlGate,
        observation: ListGatewaySessionsResult | undefined
    ): boolean {
        if (
            observation === undefined ||
            providerControlGeneration.current !== gate.generation ||
            !chatProviderObservationIsNewer(gate, observation)
        ) {
            return false;
        }
        releaseProviderControl(gate.generation);
        setSendSettings((current) => {
            if (current[gate.sessionKey] === undefined) return current;
            const next = { ...current };
            delete next[gate.sessionKey];
            return next;
        });
        return true;
    }

    async function runProviderObservedMutation<TResult>(
        generation: number,
        sessionKey: string,
        mutate: (signal: AbortSignal) => Promise<TResult>,
        additionalCancellationKeys: readonly QueryKey[] = [],
        onMutationOutput?: (output: TResult) => void
    ): Promise<ProviderObservedMutationResult<TResult> | undefined> {
        let operationIsActive = inactiveCompanionOperation;
        try {
            return await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                await Promise.all([
                    queryClient.cancelQueries({
                        exact: true,
                        queryKey: gatewaySessionQueryKey,
                    }),
                    ...additionalCancellationKeys.map((queryKey) =>
                        queryClient.cancelQueries({ exact: true, queryKey })
                    ),
                ]);
                assertAuthenticatedMutationOwner(isActive);
                const snapshot =
                    queryClient.getQueryData<ListGatewaySessionsResult>(
                        gatewaySessionQueryKey
                    );
                if (snapshot === undefined) {
                    throw new TypeError("Chat provider inventory is unavailable");
                }
                const gate: ProviderControlGate = {
                    generation,
                    observedAtMs: snapshot.source.observedAtMs,
                    sessionKey,
                };
                setProviderControlGate(gate);

                let outcomeError: unknown;
                let output: TResult | undefined;
                try {
                    output = await mutate(signal);
                    assertAuthenticatedMutationOwner(isActive);
                    onMutationOutput?.(output);
                } catch (error) {
                    assertAuthenticatedMutationOwner(isActive);
                    outcomeError = error;
                    if (!isDashboardOperationOutcomeUnknown(error)) {
                        return { gate, outcomeError, ownerIsActive: isActive };
                    }
                }

                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: gatewaySessionQueryKey,
                });
                assertAuthenticatedMutationOwner(isActive);
                let observation: ListGatewaySessionsResult | undefined;
                let observationError: unknown;
                try {
                    observation = await client.query(
                        "gatewaySessions.list",
                        { filter: "ALL" },
                        { signal }
                    );
                    assertAuthenticatedMutationOwner(isActive);
                    queryClient.setQueryData(gatewaySessionQueryKey, observation);
                } catch (error) {
                    assertAuthenticatedMutationOwner(isActive);
                    observationError = error;
                }
                return {
                    gate,
                    ...(observation === undefined ? {} : { observation }),
                    ...(observationError === undefined ? {} : { observationError }),
                    ...(outcomeError === undefined ? {} : { outcomeError }),
                    ...(output === undefined ? {} : { output }),
                    ownerIsActive: isActive,
                };
            });
        } catch (error) {
            if (!operationIsActive()) return undefined;
            throw error;
        }
    }

    async function reconcileProviderControl(): Promise<boolean> {
        const gate = providerControlGate;
        if (gate === undefined) return true;
        let operationIsActive = inactiveCompanionOperation;
        try {
            const observation = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: gatewaySessionQueryKey,
                });
                assertAuthenticatedMutationOwner(isActive);
                const result = await client.query(
                    "gatewaySessions.list",
                    { filter: "ALL" },
                    { signal }
                );
                assertAuthenticatedMutationOwner(isActive);
                queryClient.setQueryData(gatewaySessionQueryKey, result);
                return result;
            });
            return operationIsActive() && acceptProviderObservation(gate, observation);
        } catch {
            return false;
        }
    }

    async function send(): Promise<void> {
        if (!canSend || selectedSessionKey === "") return;
        setActionError(undefined);
        setActionNotice(undefined);
        const command = currentDraft.text.trim();
        if (command === "/help") {
            setActionNotice(
                "Commands: /compact, /reset, /model <id>, and /thinking <level>."
            );
            updateDraft(selectedSessionKey, (draft) => ({
                ...draft,
                text: "",
                version: draft.version + 1,
            }));
            return;
        }
        if (command === "/compact") {
            updateDraft(selectedSessionKey, (draft) => ({
                ...draft,
                text: "",
                version: draft.version + 1,
            }));
            await compact();
            return;
        }
        if (command === "/reset") {
            setActionNotice(
                "Open Chat settings and choose Reset chat history to continue."
            );
            return;
        }
        if (command.startsWith("/model ")) {
            const model = command.slice(7).trim();
            if (selectedSession?.modelOptions.includes(model) !== true) {
                setActionError("That model is not available for this session.");
                return;
            }
            updateDraft(selectedSessionKey, (draft) => ({
                ...draft,
                text: "",
                version: draft.version + 1,
            }));
            await updateProviderSettings({ ...currentSendSettings, model });
            return;
        }
        if (command.startsWith("/thinking ")) {
            const thinking = command.slice(10).trim();
            if (selectedSession?.thinkingOptions.includes(thinking) !== true) {
                setActionError("That thinking level is not available for this session.");
                return;
            }
            updateDraft(selectedSessionKey, (draft) => ({
                ...draft,
                text: "",
                version: draft.version + 1,
            }));
            await updateProviderSettings({ ...currentSendSettings, thinking });
            return;
        }

        const captured = currentDraft;
        const identity = createChatSendIdentity();
        const uploadAttachments = captured.attachments.map(
            (attachment): ChatDraftAttachment => ({
                ...attachment,
                progress: 0,
                status: "preparing",
            })
        );
        const optimisticAttachments = uploadAttachments.map(
            (attachment): ChatOptimisticAttachment => ({
                id: attachment.id,
                mediaType: attachment.mediaType,
                name: attachment.name,
                progress: attachment.progress,
                sizeBytes: attachment.sizeBytes,
                status: attachment.status,
            })
        );
        runtimeStore.enqueue({
            attachments: optimisticAttachments,
            clientRunId: identity.clientRunId,
            createdAtMs: Date.now(),
            delivery: "sending",
            idempotencyKey: identity.idempotencyKey,
            sessionKey: selectedSessionKey,
            text: captured.text,
        });
        updateDraft(selectedSessionKey, (draft) => ({
            attachments: [],
            text: "",
            version: draft.version + 1,
        }));
        try {
            await mutationBoundary.run((signal) =>
                executeChatSend(client, {
                    attachments: uploadAttachments,
                    identity,
                    message: captured.text,
                    onAttachmentProgress: (attachmentId, progress, status) =>
                        runtimeStore.updateSendAttachment(
                            selectedSessionKey,
                            identity.clientRunId,
                            attachmentId,
                            progress,
                            status
                        ),
                    sessionKey: selectedSessionKey,
                    settings: currentSendSettings,
                    signal,
                })
            );
            runtimeStore.updateSend(selectedSessionKey, identity.clientRunId, {
                delivery: "accepted",
            });
            void queryClient.invalidateQueries({
                exact: true,
                queryKey: chatRuntimeQueryKey(selectedSessionKey),
            });
        } catch (error) {
            if (chatSendFailureDisposition(error) === "keep-pending") {
                runtimeStore.updateSend(selectedSessionKey, identity.clientRunId, {
                    delivery: "reconciling",
                    error: "Outcome is unknown",
                });
                setActionError(
                    "Dashboard could not confirm whether the message was sent. It will check automatically. Do not send it again."
                );
                return;
            }
            runtimeStore.updateSend(selectedSessionKey, identity.clientRunId, {
                delivery: "failed",
                error: "Send failed",
            });
            setActionError(dashboardBrowserFailureMessage(error));
            setDrafts((current) => {
                const latest = current[selectedSessionKey] ?? emptyDraft();
                if (
                    latest.version !== captured.version + 1 ||
                    latest.text !== "" ||
                    latest.attachments.length > 0
                ) {
                    return current;
                }
                return {
                    ...current,
                    [selectedSessionKey]: {
                        attachments: captured.attachments,
                        text: captured.text,
                        version: latest.version + 1,
                    },
                };
            });
            runtimeStore.dismissSend(selectedSessionKey, identity.clientRunId);
        }
    }

    async function openLocalFile(reference: string): Promise<void> {
        setActionError(undefined);
        const previewWindow = globalThis.open("about:blank", "_blank");
        try {
            const ticket = await mutationBoundary.run((signal) =>
                workspaceFileClient(client).query(
                    "files.prepareReference",
                    { reference },
                    { signal }
                )
            );
            if (previewWindow === null) {
                globalThis.location.assign(ticket.url);
                return;
            }
            previewWindow.opener = null;
            previewWindow.location.replace(ticket.url);
        } catch (error) {
            previewWindow?.close();
            if (mutationBoundary.completionIsCurrent()) {
                setActionError(dashboardBrowserFailureMessage(error));
            }
        }
    }

    async function abortExternal(
        controlId: string,
        providerRunId: string
    ): Promise<void> {
        if (!providerWritesEnabled) return;
        const sessionKey = selectedSessionKey;
        const externalRun =
            runtimeStore.state.sessions[sessionKey]?.externalRuns[providerRunId];
        if (
            externalRun?.continuity !== "complete" ||
            externalRun.lifecycle !== "active"
        ) {
            return;
        }
        if (externalAbortBoundaryIsGated(externalRun)) return;
        const priorGate = externalAbortLocks.current.get(controlId);
        if (priorGate !== undefined) {
            const abortBoundary = externalRun.abortBoundary;
            if (
                priorGate.sessionKey === sessionKey &&
                (abortBoundary?.attemptId !== priorGate.attemptId ||
                    (abortBoundary.settlement !== "not-aborted" &&
                        (externalRun.observationEpoch <=
                            abortBoundary.baselineObservationEpoch ||
                            externalRun.observedAtMs <= abortBoundary.attemptedAtMs ||
                            externalRun.updatedAtMs <=
                                abortBoundary.baselineUpdatedAtMs)))
            ) {
                return;
            }
            externalAbortLocks.current.delete(controlId);
        }
        const gate: ExternalAbortGate = {
            attemptId: createChatIdempotencyKey(),
            sessionKey,
        };
        const releaseGate = () => {
            if (externalAbortLocks.current.get(controlId) !== gate) return;
            externalAbortLocks.current.delete(controlId);
            setExternalAbortGates((current) => {
                if (current[controlId] !== gate) return current;
                const next = { ...current };
                delete next[controlId];
                return next;
            });
        };
        const reconcileGate = (includeHistory = false) => {
            const historyCatchUp = includeHistory
                ? queryClient.invalidateQueries({
                      exact: true,
                      queryKey: chatHistoryQueryKey(sessionKey),
                  })
                : Promise.resolve();
            void historyCatchUp
                .then(() =>
                    queryClient.invalidateQueries({
                        exact: true,
                        queryKey: chatRuntimeQueryKey(sessionKey),
                    })
                )
                .then(() => {
                    const observedRun =
                        runtimeStore.state.sessions[sessionKey]?.externalRuns[
                            providerRunId
                        ];
                    const abortBoundary = observedRun?.abortBoundary;
                    if (
                        observedRun === undefined ||
                        (abortBoundary?.attemptId === gate.attemptId &&
                            (abortBoundary.settlement === "not-aborted" ||
                                (observedRun.observationEpoch >
                                    abortBoundary.baselineObservationEpoch &&
                                    observedRun.observedAtMs >
                                        abortBoundary.attemptedAtMs &&
                                    observedRun.updatedAtMs >
                                        abortBoundary.baselineUpdatedAtMs)))
                    ) {
                        releaseGate();
                    }
                    return null;
                });
        };
        externalAbortLocks.current.set(controlId, gate);
        setExternalAbortGates((current) => ({
            ...current,
            [controlId]: gate,
        }));
        setActionError(undefined);
        setActionNotice(undefined);
        let operationIsActive = inactiveCompanionOperation;
        try {
            const output = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                assertAuthenticatedMutationOwner(isActive);
                const result = await client.mutation(
                    "chat.abort",
                    {
                        abortAttemptId: gate.attemptId,
                        providerRunId,
                        sessionKey,
                    },
                    { signal }
                );
                assertAuthenticatedMutationOwner(isActive);
                return result;
            });
            if (!operationIsActive()) return;
            if (
                !("abortAttemptId" in output) ||
                output.abortAttemptId !== gate.attemptId
            ) {
                reconcileGate(true);
                setActionError(
                    "Dashboard could not confirm whether the response stopped. It will check automatically."
                );
                return;
            }
            if (!output.aborted) {
                releaseGate();
                setActionError(
                    "OpenClaw did not stop this response. Its live status has been refreshed. Try again if it is still running."
                );
            }
            reconcileGate();
        } catch (error) {
            if (!operationIsActive()) return;
            const unknown = isDashboardOperationOutcomeUnknown(error);
            if (unknown) {
                reconcileGate(true);
            } else {
                releaseGate();
            }
            setActionError(
                unknown
                    ? "Dashboard could not confirm whether the response stopped. It will check automatically."
                    : dashboardBrowserFailureMessage(error)
            );
        }
    }

    async function abort(runId: string): Promise<void> {
        const providerRunId = providerRunIdFromControlId(runId);
        if (providerRunId !== undefined) {
            await abortExternal(runId, providerRunId);
            return;
        }
        if (!providerWritesEnabled) return;
        const sessionKey = selectedSessionKey;
        if (abortLocks.current.has(runId)) return;
        abortLocks.current.add(runId);
        setActionError(undefined);
        let operationIsActive = inactiveCompanionOperation;
        try {
            const result = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(sessionKey),
                });
                assertAuthenticatedMutationOwner(isActive);
                const currentRun = runtimeStore.state.sessions[sessionKey]?.runs[runId];
                if (currentRun?.phase !== "active") {
                    return { ownerIsActive: isActive };
                }
                const gate: ChatAbortGate = {
                    reconciliation: currentRun.reconciliation,
                    runLastSequence: currentRun.lastSequence,
                    sessionKey,
                };
                setAbortGates((current) => ({ ...current, [runId]: gate }));

                let outcomeError: unknown;
                try {
                    await client.mutation(
                        "chat.abort",
                        { runId, sessionKey },
                        { signal }
                    );
                    assertAuthenticatedMutationOwner(isActive);
                } catch (error) {
                    assertAuthenticatedMutationOwner(isActive);
                    outcomeError = error;
                    if (!isDashboardOperationOutcomeUnknown(error)) {
                        return { gate, outcomeError, ownerIsActive: isActive };
                    }
                }

                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(sessionKey),
                });
                assertAuthenticatedMutationOwner(isActive);
                let observation: ChatRuntimeBatch | undefined;
                let observationError: unknown;
                try {
                    observation = await readChatRuntimeBatch(
                        client,
                        sessionKey,
                        String(runtimeStore.cursorFor(sessionKey)),
                        signal,
                        runtimeStore.transcriptGenerationFor(sessionKey)
                    );
                    assertAuthenticatedMutationOwner(isActive);
                    queryClient.setQueryData(
                        chatRuntimeQueryKey(sessionKey),
                        observation
                    );
                } catch (error) {
                    assertAuthenticatedMutationOwner(isActive);
                    observationError = error;
                }
                return {
                    gate,
                    ...(observation === undefined ? {} : { observation }),
                    ...(observationError === undefined ? {} : { observationError }),
                    ...(outcomeError === undefined ? {} : { outcomeError }),
                    ownerIsActive: isActive,
                };
            });
            if (!operationIsActive()) return;
            if (result.gate === undefined) {
                abortLocks.current.delete(runId);
                return;
            }
            const observation = "observation" in result ? result.observation : undefined;
            const advanced =
                observation !== undefined &&
                chatRuntimeObservationAdvancesRun({ ...result.gate, runId }, observation);
            if (advanced && observation !== undefined) {
                const application = applyChatRuntimeBatch(observation, runtimeStore);
                if (application.historyMayHaveChanged) {
                    void queryClient.invalidateQueries({
                        exact: true,
                        queryKey: chatHistoryQueryKey(sessionKey),
                    });
                }
                abortLocks.current.delete(runId);
                setAbortGates((current) => {
                    const next = { ...current };
                    delete next[runId];
                    return next;
                });
            }
            if (result.outcomeError !== undefined) {
                setActionError(
                    isDashboardOperationOutcomeUnknown(result.outcomeError)
                        ? "Dashboard could not confirm whether the response stopped. It will check automatically."
                        : dashboardBrowserFailureMessage(result.outcomeError)
                );
            } else if (!advanced) {
                setActionError(
                    "The stop request was accepted. Controls remain paused until OpenClaw reports a newer status."
                );
            }
            if (
                result.outcomeError !== undefined &&
                !isDashboardOperationOutcomeUnknown(result.outcomeError)
            ) {
                abortLocks.current.delete(runId);
                setAbortGates((current) => {
                    const next = { ...current };
                    delete next[runId];
                    return next;
                });
            }
        } catch (error) {
            if (!operationIsActive()) return;
            abortLocks.current.delete(runId);
            setAbortGates((current) => {
                const next = { ...current };
                delete next[runId];
                return next;
            });
            setActionError(dashboardBrowserFailureMessage(error));
        }
    }

    async function reconcileAbort(runId: string, gate: ChatAbortGate): Promise<boolean> {
        let operationIsActive = inactiveCompanionOperation;
        try {
            const observation = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(gate.sessionKey),
                });
                assertAuthenticatedMutationOwner(isActive);
                const result = await readChatRuntimeBatch(
                    client,
                    gate.sessionKey,
                    String(runtimeStore.cursorFor(gate.sessionKey)),
                    signal,
                    runtimeStore.transcriptGenerationFor(gate.sessionKey)
                );
                assertAuthenticatedMutationOwner(isActive);
                queryClient.setQueryData(chatRuntimeQueryKey(gate.sessionKey), result);
                return result;
            });
            if (
                !operationIsActive() ||
                !chatRuntimeObservationAdvancesRun({ ...gate, runId }, observation)
            ) {
                return false;
            }
            const application = applyChatRuntimeBatch(observation, runtimeStore);
            if (application.historyMayHaveChanged) {
                void queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatHistoryQueryKey(gate.sessionKey),
                });
            }
            abortLocks.current.delete(runId);
            setAbortGates((current) => {
                if (current[runId] !== gate) return current;
                const next = { ...current };
                delete next[runId];
                return next;
            });
            return true;
        } catch {
            return false;
        }
    }

    async function updateProviderSettings(next: ChatSendSettings): Promise<void> {
        if (
            selectedSessionKey === "" ||
            selectedSession === undefined ||
            !providerWritesEnabled ||
            providerControlLock.current
        ) {
            return;
        }
        const sessionKey = selectedSessionKey;
        const previous = currentSendSettings;
        const generation = providerControlGeneration.current + 1;
        providerControlGeneration.current = generation;
        providerControlLock.current = true;
        setSendSettings((current) => ({ ...current, [sessionKey]: next }));
        setPendingActions((count) => count + 1);
        setActionError(undefined);
        try {
            const result = await runProviderObservedMutation(
                generation,
                sessionKey,
                (signal) => {
                    const expectedSessionId = queryClient
                        .getQueryData<ListGatewaySessionsResult>(gatewaySessionQueryKey)
                        ?.sessions.find(({ key }) => key === sessionKey)?.sessionId;
                    return client.mutation(
                        "chat.updateSessionSettings",
                        {
                            sessionKey,
                            ...(expectedSessionId === undefined
                                ? {}
                                : { expectedSessionId }),
                            ...(next.fastMode === undefined
                                ? {}
                                : { fastMode: next.fastMode }),
                            model: next.model ?? null,
                            thinkingLevel: next.thinking ?? null,
                        },
                        { signal }
                    );
                },
                [],
                (output) => {
                    setSendSettings((current) => ({
                        ...current,
                        [sessionKey]: {
                            ...(output.fastMode === null || output.fastMode === undefined
                                ? {}
                                : { fastMode: output.fastMode }),
                            ...(output.model === null || output.model === undefined
                                ? {}
                                : { model: output.model }),
                            speed: effectiveChatSpeed(output.fastMode, next.speed),
                            ...(output.thinkingLevel === null ||
                            output.thinkingLevel === undefined
                                ? {}
                                : { thinking: output.thinkingLevel }),
                        },
                    }));
                }
            );
            if (result === undefined || !result.ownerIsActive()) return;
            const outcomeUnknown =
                result.outcomeError !== undefined &&
                isDashboardOperationOutcomeUnknown(result.outcomeError);
            if (result.outcomeError !== undefined && !outcomeUnknown) {
                releaseProviderControl(generation);
                setSendSettings((current) => ({
                    ...current,
                    [sessionKey]: previous,
                }));
                setActionError(dashboardBrowserFailureMessage(result.outcomeError));
                return;
            }
            const reconciled = acceptProviderObservation(result.gate, result.observation);
            if (!reconciled) {
                setActionError(
                    outcomeUnknown
                        ? "Dashboard could not confirm the settings change. It will check automatically before the controls become available again."
                        : "Settings were saved. Dashboard is checking OpenClaw before the controls become available again."
                );
            }
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                releaseProviderControl(generation);
                setSendSettings((current) => ({
                    ...current,
                    [sessionKey]: previous,
                }));
                setActionError(dashboardBrowserFailureMessage(error));
            }
        } finally {
            if (mutationBoundary.completionIsCurrent()) {
                setPendingActions((count) => Math.max(0, count - 1));
            }
        }
    }

    async function compact(): Promise<void> {
        if (
            selectedSessionKey === "" ||
            !providerWritesEnabled ||
            providerControlLock.current
        ) {
            return;
        }
        const sessionKey = selectedSessionKey;
        const generation = providerControlGeneration.current + 1;
        providerControlGeneration.current = generation;
        providerControlLock.current = true;
        setPendingActions((count) => count + 1);
        setActionError(undefined);
        try {
            const result = await runProviderObservedMutation(
                generation,
                sessionKey,
                (signal) =>
                    client.mutation(
                        "gatewaySessions.compact",
                        { key: sessionKey },
                        {
                            signal,
                        }
                    ),
                [chatHistoryQueryKey(sessionKey), chatRuntimeQueryKey(sessionKey)]
            );
            if (result === undefined || !result.ownerIsActive()) return;
            const outcomeUnknown =
                result.outcomeError !== undefined &&
                isDashboardOperationOutcomeUnknown(result.outcomeError);
            if (result.outcomeError !== undefined && !outcomeUnknown) {
                releaseProviderControl(generation);
                setActionError(dashboardBrowserFailureMessage(result.outcomeError));
                return;
            }
            await Promise.all([
                queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatHistoryQueryKey(sessionKey),
                }),
                queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(sessionKey),
                }),
            ]);
            assertAuthenticatedMutationOwner(result.ownerIsActive);
            const reconciled = acceptProviderObservation(result.gate, result.observation);
            if (!reconciled) {
                setActionError(
                    outcomeUnknown
                        ? "Dashboard could not confirm whether the chat history was shortened. It will check automatically before the controls become available again."
                        : "Chat history was shortened. Dashboard is checking OpenClaw before the controls become available again."
                );
            }
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                releaseProviderControl(generation);
                setActionError(dashboardBrowserFailureMessage(error));
            }
        } finally {
            if (mutationBoundary.completionIsCurrent()) {
                setPendingActions((count) => Math.max(0, count - 1));
            }
        }
    }

    async function resetTranscript(sessionKey: string): Promise<void> {
        if (sessionKey === "" || !providerWritesEnabled || providerControlLock.current) {
            return;
        }
        const generation = providerControlGeneration.current + 1;
        providerControlGeneration.current = generation;
        providerControlLock.current = true;
        setPendingActions((count) => count + 1);
        setActionError(undefined);
        try {
            const result = await runProviderObservedMutation(
                generation,
                sessionKey,
                (signal) =>
                    client.mutation(
                        "gatewaySessions.reset",
                        { key: sessionKey },
                        {
                            signal,
                        }
                    ),
                [chatHistoryQueryKey(sessionKey), chatRuntimeQueryKey(sessionKey)]
            );
            if (result === undefined || !result.ownerIsActive()) return;
            const outcomeUnknown =
                result.outcomeError !== undefined &&
                isDashboardOperationOutcomeUnknown(result.outcomeError);
            if (result.outcomeError !== undefined && !outcomeUnknown) {
                releaseProviderControl(generation);
                setActionError(dashboardBrowserFailureMessage(result.outcomeError));
                return;
            }
            if (!outcomeUnknown) {
                runtimeStore.clearSession(sessionKey);
                setHydrationTarget((current) =>
                    current?.sessionKey === sessionKey ? undefined : current
                );
            }
            await Promise.all([
                queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatHistoryQueryKey(sessionKey),
                }),
                queryClient.invalidateQueries({
                    exact: true,
                    queryKey: chatRuntimeQueryKey(sessionKey),
                }),
            ]);
            assertAuthenticatedMutationOwner(result.ownerIsActive);
            const reconciled = acceptProviderObservation(result.gate, result.observation);
            if (!reconciled) {
                setActionError(
                    outcomeUnknown
                        ? "Dashboard could not confirm whether the chat history was reset. It will check automatically before the controls become available again."
                        : "Chat history was reset. Dashboard is checking OpenClaw before the controls become available again."
                );
            }
        } catch (error) {
            if (mutationBoundary.completionIsCurrent()) {
                releaseProviderControl(generation);
                setActionError(dashboardBrowserFailureMessage(error));
            }
        } finally {
            if (mutationBoundary.completionIsCurrent()) {
                setPendingActions((count) => Math.max(0, count - 1));
            }
        }
    }

    function acceptCompanionObservation(
        sessionKey: string,
        gate: CompanionOperationGate,
        observation: ChatCompanionStateOutput
    ): boolean {
        if (
            !gate.ownerIsActive() ||
            (companionGenerations.current[sessionKey] ?? 0) !== gate.generation
        ) {
            return false;
        }
        let nextCompanion: ChatWorkspaceView["companion"];
        if (gate.kind === "ask") {
            const exchange = observation.exchanges.findLast(
                (candidate) =>
                    candidate.question === gate.question &&
                    candidate.timestampMs > gate.exchangeBoundaryMs
            );
            if (exchange === undefined) return false;
            nextCompanion = {
                answer: exchange.answer,
                question: exchange.question,
                status: "ready",
            };
            companionAskLocks.current.delete(sessionKey);
        } else {
            if (
                !chatCompanionResetObservationConfirmsReset(
                    gate.observationBoundary,
                    observation
                )
            ) {
                return false;
            }
            nextCompanion = { status: "idle" };
            companionResetLocks.current.delete(sessionKey);
        }
        setCompanionGates((current) => {
            if (current[sessionKey]?.generation !== gate.generation) return current;
            const next = { ...current };
            delete next[sessionKey];
            return next;
        });
        setCompanionOverride((current) => ({
            ...current,
            [sessionKey]: nextCompanion,
        }));
        return true;
    }

    async function reconcileCompanionOperation(sessionKey: string): Promise<boolean> {
        const gate = companionGates[sessionKey];
        if (gate === undefined || !gate.ownerIsActive()) return gate === undefined;
        try {
            await queryClient.cancelQueries({
                exact: true,
                queryKey: chatCompanionQueryKey(sessionKey),
            });
            if (!gate.ownerIsActive()) return false;
            const observation = await mutationBoundary.run(async (signal, isActive) => {
                const result = await client.query(
                    "chat.companionState",
                    { sessionKey },
                    { signal }
                );
                assertAuthenticatedMutationOwner(isActive);
                queryClient.setQueryData(chatCompanionQueryKey(sessionKey), result);
                return result;
            });
            if (!gate.ownerIsActive()) return false;
            return acceptCompanionObservation(sessionKey, gate, observation);
        } catch {
            return false;
        }
    }

    async function askCompanion(question: string): Promise<void> {
        if (
            selectedSessionKey === "" ||
            !providerWritesEnabled ||
            companion.status === "answering" ||
            companion.status === "resetting" ||
            companionAskLocks.current.has(selectedSessionKey) ||
            companionResetLocks.current.has(selectedSessionKey)
        ) {
            return;
        }
        const sessionKey = selectedSessionKey;
        const generation = (companionGenerations.current[sessionKey] ?? 0) + 1;
        companionGenerations.current = {
            ...companionGenerations.current,
            [sessionKey]: generation,
        };
        const askController = new AbortController();
        companionAskControllers.current.set(sessionKey, askController);
        companionAskLocks.current.add(sessionKey);
        let exchangeBoundaryMs = 0;
        setCompanionOverride((current) => ({
            ...current,
            [sessionKey]: { question, status: "answering" },
        }));
        let operationIsActive = inactiveCompanionOperation;
        let operationSignal: AbortSignal | undefined;
        const canCommit = () =>
            operationIsActive() &&
            (companionGenerations.current[sessionKey] ?? 0) === generation;
        const releaseAskOperation = () => {
            if (companionAskControllers.current.get(sessionKey) === askController) {
                companionAskControllers.current.delete(sessionKey);
            }
            companionAskLocks.current.delete(sessionKey);
        };
        const discardExpiredOperation = () => {
            if ((companionGenerations.current[sessionKey] ?? 0) !== generation) {
                return;
            }
            releaseAskOperation();
            setCompanionGates((current) => {
                const next = { ...current };
                delete next[sessionKey];
                return next;
            });
            setCompanionOverride((current) => {
                const next = { ...current };
                delete next[sessionKey];
                return next;
            });
        };
        try {
            const output = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                operationSignal = signal;
                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: chatCompanionQueryKey(sessionKey),
                });
                assertAuthenticatedMutationOwner(isActive);
                const companionState = queryClient.getQueryData<ChatCompanionStateOutput>(
                    chatCompanionQueryKey(sessionKey)
                );
                exchangeBoundaryMs = Math.max(
                    0,
                    ...(companionState?.exchanges.map(({ timestampMs }) => timestampMs) ??
                        [])
                );
                const result = await client.mutation(
                    "chat.companionAsk",
                    { question, sessionKey },
                    {
                        signal: authenticatedAbortSignal(signal, [askController.signal]),
                    }
                );
                assertAuthenticatedMutationOwner(isActive);
                return result;
            });
            if (!canCommit()) {
                if (operationIsActive()) discardExpiredOperation();
                return;
            }
            releaseAskOperation();
            setCompanionGates((current) => {
                const next = { ...current };
                delete next[sessionKey];
                return next;
            });
            setCompanionOverride((current) => ({
                ...current,
                [sessionKey]: {
                    answer: output.answer,
                    question,
                    status: "ready",
                },
            }));
            void queryClient.invalidateQueries({
                queryKey: chatCompanionQueryKey(sessionKey),
            });
        } catch (error) {
            if (!canCommit()) {
                if (operationIsActive()) discardExpiredOperation();
                return;
            }
            if (isDashboardOperationOutcomeUnknown(error)) {
                if (companionAskControllers.current.get(sessionKey) === askController) {
                    companionAskControllers.current.delete(sessionKey);
                }
                const gate: CompanionAskGate = {
                    exchangeBoundaryMs,
                    generation,
                    kind: "ask",
                    ownerIsActive: operationIsActive,
                    question,
                };
                setCompanionGates((current) => ({
                    ...current,
                    [sessionKey]: gate,
                }));
                setCompanionOverride((current) => ({
                    ...current,
                    [sessionKey]: {
                        error: "Dashboard could not confirm whether the chat companion received the question. It will check automatically. Do not submit it again.",
                        question,
                        status: "answering",
                    },
                }));
                try {
                    await queryClient.cancelQueries({
                        exact: true,
                        queryKey: chatCompanionQueryKey(sessionKey),
                    });
                    if (!canCommit()) return;
                    if (operationSignal === undefined) return;
                    const observation = await client.query(
                        "chat.companionState",
                        { sessionKey },
                        { signal: operationSignal }
                    );
                    if (!canCommit()) return;
                    queryClient.setQueryData(
                        chatCompanionQueryKey(sessionKey),
                        observation
                    );
                    acceptCompanionObservation(sessionKey, gate, observation);
                } catch {
                    if (!canCommit()) return;
                }
                return;
            }
            releaseAskOperation();
            setCompanionOverride((current) => ({
                ...current,
                [sessionKey]: {
                    error: dashboardBrowserFailureMessage(error),
                    question,
                    status: "error",
                },
            }));
        }
    }

    async function resetCompanion(): Promise<void> {
        if (
            selectedSessionKey === "" ||
            !providerWritesEnabled ||
            companion.status === "resetting" ||
            companionResetLocks.current.has(selectedSessionKey)
        ) {
            return;
        }
        const sessionKey = selectedSessionKey;
        const generation = (companionGenerations.current[sessionKey] ?? 0) + 1;
        companionGenerations.current = {
            ...companionGenerations.current,
            [sessionKey]: generation,
        };
        companionAskControllers.current.get(sessionKey)?.abort();
        companionAskControllers.current.delete(sessionKey);
        companionAskLocks.current.delete(sessionKey);
        companionResetLocks.current.add(sessionKey);
        setCompanionGates((current) => {
            const next = { ...current };
            delete next[sessionKey];
            return next;
        });
        const companionBeforeReset = companion;
        let observationBoundary: ChatCompanionResetObservationBoundary = {};
        setCompanionOverride((current) => ({
            ...current,
            [sessionKey]: companionOperationView(companionBeforeReset, "resetting"),
        }));
        let operationIsActive = inactiveCompanionOperation;
        let operationSignal: AbortSignal | undefined;
        const canCommit = () =>
            operationIsActive() &&
            (companionGenerations.current[sessionKey] ?? 0) === generation;
        const discardExpiredOperation = () => {
            if ((companionGenerations.current[sessionKey] ?? 0) !== generation) {
                return;
            }
            companionResetLocks.current.delete(sessionKey);
            setCompanionGates((current) => {
                const next = { ...current };
                delete next[sessionKey];
                return next;
            });
            setCompanionOverride((current) => {
                const next = { ...current };
                delete next[sessionKey];
                return next;
            });
        };
        try {
            await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                operationSignal = signal;
                await queryClient.cancelQueries({
                    exact: true,
                    queryKey: chatCompanionQueryKey(sessionKey),
                });
                assertAuthenticatedMutationOwner(isActive);
                observationBoundary = {
                    stateFingerprint: chatCompanionStateFingerprint(
                        queryClient.getQueryData<ChatCompanionStateOutput>(
                            chatCompanionQueryKey(sessionKey)
                        )
                    ),
                };
                const result = await client.mutation(
                    "chat.companionReset",
                    { sessionKey },
                    { signal }
                );
                assertAuthenticatedMutationOwner(isActive);
                return result;
            });
            if (!canCommit()) {
                if (operationIsActive()) discardExpiredOperation();
                return;
            }
            companionResetLocks.current.delete(sessionKey);
            setCompanionOverride((current) => ({
                ...current,
                [sessionKey]: { status: "idle" },
            }));
            queryClient.removeQueries({
                exact: true,
                queryKey: chatCompanionQueryKey(sessionKey),
            });
        } catch (error) {
            if (!canCommit()) {
                if (operationIsActive()) discardExpiredOperation();
                return;
            }
            if (isDashboardOperationOutcomeUnknown(error)) {
                const gate: CompanionResetGate = {
                    generation,
                    kind: "reset",
                    observationBoundary,
                    ownerIsActive: operationIsActive,
                };
                setCompanionGates((current) => ({
                    ...current,
                    [sessionKey]: gate,
                }));
                setCompanionOverride((current) => ({
                    ...current,
                    [sessionKey]: companionOperationView(
                        companionBeforeReset,
                        "resetting",
                        "Dashboard could not confirm whether the chat companion was reset. It will check automatically. Do not reset it again."
                    ),
                }));
                try {
                    await queryClient.cancelQueries({
                        exact: true,
                        queryKey: chatCompanionQueryKey(sessionKey),
                    });
                    if (!canCommit()) return;
                    if (operationSignal === undefined) return;
                    const observation = await client.query(
                        "chat.companionState",
                        { sessionKey },
                        { signal: operationSignal }
                    );
                    if (!canCommit()) return;
                    queryClient.setQueryData(
                        chatCompanionQueryKey(sessionKey),
                        observation
                    );
                    acceptCompanionObservation(sessionKey, gate, observation);
                } catch {
                    if (!canCommit()) return;
                }
                return;
            }
            companionResetLocks.current.delete(sessionKey);
            setCompanionOverride((current) => ({
                ...current,
                [sessionKey]: companionOperationView(
                    companionBeforeReset,
                    "error",
                    dashboardBrowserFailureMessage(error)
                ),
            }));
        }
    }

    function settleAbsentTask(taskId: string): void {
        taskCancelLocks.current.delete(taskId);
        setTaskCancelGates((current) => {
            const next = { ...current };
            delete next[taskId];
            return next;
        });
        setTaskOverrides((current) => {
            const next = { ...current };
            delete next[taskId];
            return next;
        });
        setAbsentTaskIds((current) => new Set([...current, taskId]));
    }

    function settleObservedTask(taskId: string): void {
        taskCancelLocks.current.delete(taskId);
        setTaskCancelGates((current) => {
            const next = { ...current };
            delete next[taskId];
            return next;
        });
        setTaskOverrides((current) => {
            const next = { ...current };
            delete next[taskId];
            return next;
        });
    }

    async function cancelTaskObservationQueries(
        sessionKey: string,
        taskId: string,
        isActive: () => boolean
    ): Promise<void> {
        await Promise.all([
            queryClient.cancelQueries({
                queryKey: openClawTaskListSessionQueryKey(sessionKey),
            }),
            queryClient.cancelQueries({
                exact: true,
                queryKey: openClawTaskDetailQueryKey(taskId),
            }),
        ]);
        assertAuthenticatedMutationOwner(isActive);
    }

    function cachedTaskObservation(
        sessionKey: string,
        taskId: string
    ): OpenClawTaskSummary | undefined {
        const lists = mergeOpenClawTaskProjectionPages(
            queryClient.getQueryData<InfiniteData<OpenClawTaskListOutput>>(
                openClawTaskListQueryKey(sessionKey, "active")
            ),
            queryClient.getQueryData<InfiniteData<OpenClawTaskListOutput>>(
                openClawTaskListQueryKey(sessionKey, "finished")
            )
        );
        const listTask = lists.find((task) => task.id === taskId);
        const detail = queryClient.getQueryData<OpenClawTaskGetOutput>(
            openClawTaskDetailQueryKey(taskId)
        )?.task;
        if (listTask === undefined) return detail;
        return reconcileChatTaskSummary(listTask, detail);
    }

    async function readTaskPostMutationObservation(
        sessionKey: string,
        taskId: string,
        isActive: () => boolean,
        signal: AbortSignal
    ): Promise<TaskPostMutationObservation> {
        await cancelTaskObservationQueries(sessionKey, taskId, isActive);
        const [active, finished, detail] = await Promise.allSettled([
            client.query(
                "openClawTasks.list",
                {
                    limit: 200,
                    sessionKey,
                    statuses: ["queued", "running"],
                },
                { signal }
            ),
            client.query(
                "openClawTasks.list",
                {
                    limit: 100,
                    sessionKey,
                    statuses: ["completed", "failed", "cancelled", "timed_out"],
                },
                { signal }
            ),
            client.query("openClawTasks.get", { taskId }, { signal }),
        ]);
        assertAuthenticatedMutationOwner(isActive);
        const activeData: InfiniteData<OpenClawTaskListOutput> | undefined =
            active.status === "fulfilled"
                ? { pageParams: [undefined], pages: [active.value] }
                : undefined;
        const finishedData: InfiniteData<OpenClawTaskListOutput> | undefined =
            finished.status === "fulfilled"
                ? { pageParams: [undefined], pages: [finished.value] }
                : undefined;
        if (activeData !== undefined) {
            queryClient.setQueryData(
                openClawTaskListQueryKey(sessionKey, "active"),
                activeData
            );
        }
        if (finishedData !== undefined) {
            queryClient.setQueryData(
                openClawTaskListQueryKey(sessionKey, "finished"),
                finishedData
            );
        }
        if (detail.status === "fulfilled") {
            queryClient.setQueryData(openClawTaskDetailQueryKey(taskId), detail.value);
        }
        const listTask = mergeOpenClawTaskProjectionPages(activeData, finishedData).find(
            (task) => task.id === taskId
        );
        const detailTask = detail.status === "fulfilled" ? detail.value.task : undefined;
        const task =
            listTask === undefined
                ? detailTask
                : reconcileChatTaskSummary(listTask, detailTask);
        return {
            absent:
                detail.status === "rejected" &&
                classifyDashboardBrowserFailure(detail.reason) === "not-found",
            ...(task === undefined ? {} : { task }),
        };
    }

    function acceptTaskObservation(
        taskId: string,
        gate: ChatTaskCancelGate,
        observation: TaskPostMutationObservation
    ): boolean {
        if (observation.absent) {
            settleAbsentTask(taskId);
            return true;
        }
        if (!chatTaskObservationAdvances(gate, observation.task)) return false;
        settleObservedTask(taskId);
        return true;
    }

    async function reconcileTaskCancellation(
        taskId: string,
        gate: ChatTaskCancelGate
    ): Promise<boolean> {
        let operationIsActive = inactiveCompanionOperation;
        try {
            const observation = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                return readTaskPostMutationObservation(
                    gate.sessionKey,
                    taskId,
                    isActive,
                    signal
                );
            });
            return (
                operationIsActive() && acceptTaskObservation(taskId, gate, observation)
            );
        } catch {
            return false;
        }
    }

    async function cancelTask(taskId: string): Promise<void> {
        if (!providerWritesEnabled) return;
        if (taskCancelLocks.current.has(taskId)) return;
        const sessionKey = selectedSessionKey;
        const authoritativeTask = authoritativeTasks.find((task) => task.id === taskId);
        setSelectedTasks((current) => ({
            ...current,
            [sessionKey]: taskId,
        }));
        if (authoritativeTask !== undefined) {
            setTaskOverrides((current) => ({
                ...current,
                [taskId]: authoritativeTask,
            }));
        }
        taskCancelLocks.current.add(taskId);
        setActionError(undefined);
        let operationIsActive = inactiveCompanionOperation;
        try {
            const result = await mutationBoundary.run(async (signal, isActive) => {
                operationIsActive = isActive;
                await cancelTaskObservationQueries(sessionKey, taskId, isActive);
                const boundaryTask = cachedTaskObservation(sessionKey, taskId);
                const gate: ChatTaskCancelGate = {
                    phase: "pending",
                    sessionKey,
                    ...(boundaryTask?.updatedAtMs === undefined
                        ? {}
                        : { taskUpdatedAtMs: boundaryTask.updatedAtMs }),
                };
                setTaskCancelGates((current) => ({ ...current, [taskId]: gate }));

                let outcomeError: unknown;
                let output: OpenClawTaskCancelOutput | undefined;
                try {
                    output = await client.mutation(
                        "openClawTasks.cancel",
                        { taskId },
                        { signal }
                    );
                    assertAuthenticatedMutationOwner(isActive);
                } catch (error) {
                    assertAuthenticatedMutationOwner(isActive);
                    outcomeError = error;
                    if (!isDashboardOperationOutcomeUnknown(error)) {
                        return { gate, outcomeError, ownerIsActive: isActive };
                    }
                }
                if (output?.found === false) {
                    return { gate, output, ownerIsActive: isActive };
                }
                setTaskCancelGates((current) => ({
                    ...current,
                    [taskId]: { ...gate, phase: "reconciling" },
                }));
                const observation = await readTaskPostMutationObservation(
                    sessionKey,
                    taskId,
                    isActive,
                    signal
                );
                assertAuthenticatedMutationOwner(isActive);
                return {
                    gate: { ...gate, phase: "reconciling" as const },
                    observation,
                    ...(outcomeError === undefined ? {} : { outcomeError }),
                    ...(output === undefined ? {} : { output }),
                    ownerIsActive: isActive,
                };
            });
            if (!operationIsActive()) return;
            const outputTask = result.output?.task;
            if (outputTask !== undefined) {
                setTaskOverrides((current) => ({
                    ...current,
                    [taskId]: outputTask,
                }));
            }
            if (result.output?.found === false) {
                settleAbsentTask(taskId);
                return;
            }
            const outcomeUnknown =
                result.outcomeError !== undefined &&
                isDashboardOperationOutcomeUnknown(result.outcomeError);
            if (result.outcomeError !== undefined && !outcomeUnknown) {
                settleObservedTask(taskId);
                setActionError(dashboardBrowserFailureMessage(result.outcomeError));
                return;
            }
            const observation = "observation" in result ? result.observation : undefined;
            const reconciled =
                observation !== undefined &&
                acceptTaskObservation(taskId, result.gate, observation);
            if (!reconciled) {
                setActionError(
                    outcomeUnknown
                        ? "Task cancellation outcome could not be confirmed. A newer task observation is required before retrying."
                        : "Task cancellation was accepted. A newer explicit task observation is required before retrying."
                );
            }
        } catch (error) {
            if (!operationIsActive()) return;
            settleObservedTask(taskId);
            setActionError(dashboardBrowserFailureMessage(error));
        }
    }

    const queryError = chatQueryError({
        ...(actionError === undefined ? {} : { actionError }),
        historyFailed: historyQuery.error !== null,
        runtimeFailed: runtimeQuery.error !== null,
        sessionsError: sessionsQuery.error,
        sessionsMissing: sessionsQuery.data === undefined,
    });
    const taskQueryFailed =
        activeTasksQuery.error !== null || finishedTasksQuery.error !== null;
    const taskQueryHasAnyData =
        activeTasksQuery.data !== undefined || finishedTasksQuery.data !== undefined;
    const taskQueriesHaveSettled =
        activeTasksQuery.data !== undefined && finishedTasksQuery.data !== undefined;
    const taskQueriesAreFetching =
        activeTasksQuery.isFetching || finishedTasksQuery.isFetching;
    const activeTasksCanLoadMore = activeTasksQuery.hasNextPage;
    const finishedTasksCanLoadMore = finishedTasksQuery.hasNextPage;
    const view: ChatWorkspaceView = {
        activePlans: chatRuntimePlans(runtimeState, selectedSessionKey),
        backgroundTasks: tasks,
        ...(taskQueryFailed && !taskQueriesAreFetching
            ? {
                  backgroundTasksError: taskQueryHasAnyData
                      ? "Background tasks could not be updated. The latest available tasks remain visible."
                      : "Background tasks are unavailable. Retry to load them.",
              }
            : {}),
        backgroundTasksHasNextPage: activeTasksCanLoadMore || finishedTasksCanLoadMore,
        backgroundTasksLoading: !taskQueriesHaveSettled && taskQueriesAreFetching,
        backgroundTasksLoadingMore:
            activeTasksQuery.isFetchingNextPage || finishedTasksQuery.isFetchingNextPage,
        companion,
        ...(companionQuery.error === null
            ? {}
            : {
                  companionError:
                      companionQuery.data === undefined
                          ? "The chat companion is unavailable. Try loading it again."
                          : "The chat companion could not be updated. The latest available answer remains visible.",
              }),
        connection,
        historyHasNextPage: historyQuery.hasNextPage,
        historyInitialLoading: historyQuery.isPending && historyQuery.data === undefined,
        historyLoading: olderHistoryLoading || historyQuery.isFetchingNextPage,
        messages,
        ...(modelsQuery.error === null
            ? {}
            : {
                  modelInventoryError:
                      "Available models could not be updated. Current chat controls remain available.",
              }),
        selectedSessionKey,
        sessionsLoading: sessionsQuery.isPending && sessionsQuery.data === undefined,
        sessions,
        ...(taskDetailQuery.error === null
            ? {}
            : {
                  taskDetailError:
                      "Task detail could not be refreshed. The summary remains visible.",
              }),
    };

    return (
        <>
            {inventoryCanResolveMissingRequest &&
                selectedSessionKey !== requestedSessionKey && (
                    <SessionSelectionNormalization
                        onSelectedSessionChange={onSelectedSessionChange}
                        requestIdentity={`${requestedSessionKey ?? "<default>"}->${selectedSessionKey}`}
                        selectedSessionKey={selectedSessionKey}
                    />
                )}
            <ChatWorkspace
                activeRunIds={allActiveRunIds}
                abortableRunId={abortableRunId}
                actionBusy={actionBusy}
                attachmentError={currentDraft.attachmentError}
                attachments={currentDraft.attachments}
                canAskCompanion={providerWritesEnabled}
                canSend={canSend}
                displaySettings={currentDisplay}
                draft={currentDraft.text}
                error={queryError}
                notice={actionNotice}
                providerWritesDisabled={providerWritesDisabled}
                onAbort={(runId) => void abort(runId)}
                onAskCompanion={(question) => void askCompanion(question)}
                onAttach={(fileList) => {
                    const proposed = [
                        ...currentDraft.attachments.map(({ file }) => file),
                        ...fileList,
                    ];
                    const policy = validateChatAttachmentFiles(proposed);
                    if (policy.message !== undefined) {
                        updateDraft(selectedSessionKey, (draft) => ({
                            ...draft,
                            attachmentError: policy.message,
                            version: draft.version + 1,
                        }));
                        return;
                    }
                    const added = createChatDraftAttachments([...fileList]);
                    updateDraft(selectedSessionKey, (draft) => ({
                        attachments: [...draft.attachments, ...added],
                        text: draft.text,
                        version: draft.version + 1,
                    }));
                }}
                onCancelTask={(taskId) => void cancelTask(taskId)}
                onCancelVoiceInput={speech.cancelVoiceInput}
                onChangeDraft={(text) =>
                    updateDraft(selectedSessionKey, (draft) => ({
                        ...draft,
                        text,
                        version: draft.version + 1,
                    }))
                }
                onCompact={() => void compact()}
                onDisplaySettingsChange={(settings) => {
                    setDisplaySettings(settings);
                    writeChatDisplaySettings(settings);
                }}
                onDismissReadAloudError={speech.dismissReadAloudError}
                onDismissVoiceInputError={speech.dismissVoiceInputError}
                onHydrateMessage={(messageId) => {
                    if (
                        hydrationTarget?.messageId === messageId &&
                        hydrationTarget.sessionKey === selectedSessionKey
                    ) {
                        void hydratedMessageQuery.refetch();
                        return;
                    }
                    setHydrationTarget({ messageId, sessionKey: selectedSessionKey });
                }}
                onLoadMoreTasks={() => {
                    void Promise.all([
                        ...(activeTasksCanLoadMore
                            ? [activeTasksQuery.fetchNextPage()]
                            : []),
                        ...(finishedTasksCanLoadMore
                            ? [finishedTasksQuery.fetchNextPage()]
                            : []),
                    ]);
                }}
                onOpenLocalFile={(reference) => void openLocalFile(reference)}
                onLoadOlder={async () => {
                    if (!historyQuery.hasNextPage) return false;
                    if (olderHistoryLoad.current !== undefined) {
                        return olderHistoryLoad.current;
                    }
                    const operation = (async () => {
                        setOlderHistoryLoading(true);
                        try {
                            const result = await historyQuery.fetchNextPage();
                            return !result.isError;
                        } finally {
                            setOlderHistoryLoading(false);
                        }
                    })();
                    olderHistoryLoad.current = operation;
                    try {
                        return await operation;
                    } finally {
                        olderHistoryLoad.current = undefined;
                    }
                }}
                onReadAloud={
                    speech.readAloudAvailable ? speech.startReadAloud : undefined
                }
                onRemoveAttachment={(id) =>
                    updateDraft(selectedSessionKey, (draft) => ({
                        ...draft,
                        attachmentError: undefined,
                        attachments: draft.attachments.filter(
                            (attachment) => attachment.id !== id
                        ),
                        version: draft.version + 1,
                    }))
                }
                onResetCompanion={() => void resetCompanion()}
                onResetTranscript={(sessionKey) => void resetTranscript(sessionKey)}
                onRetryCompanion={() => {
                    const gate = companionGates[selectedSessionKey];
                    if (gate === undefined) {
                        void companionQuery.refetch();
                        return;
                    }
                    void reconcileCompanionOperation(selectedSessionKey);
                }}
                onRetryModels={() => void modelsQuery.refetch()}
                onRetryTasks={() => {
                    const gates = Object.entries(taskCancelGates);
                    if (gates.length > 0) {
                        void Promise.all(
                            gates.map(([taskId, gate]) =>
                                reconcileTaskCancellation(taskId, gate)
                            )
                        );
                        return;
                    }
                    void Promise.all([
                        activeTasksQuery.refetch(),
                        finishedTasksQuery.refetch(),
                        ...(selectedTaskId === undefined
                            ? []
                            : [taskDetailQuery.refetch()]),
                    ]);
                }}
                onRetry={() => {
                    setActionError(undefined);
                    void (async () => {
                        await (providerControlGate === undefined
                            ? sessionsQuery.refetch()
                            : reconcileProviderControl());
                        const gates = Object.entries(abortGates);
                        await Promise.all([
                            historyQuery.refetch(),
                            ...(gates.length === 0
                                ? [runtimeQuery.refetch()]
                                : gates.map(([runId, gate]) =>
                                      reconcileAbort(runId, gate)
                                  )),
                        ]);
                    })();
                }}
                onSelectSession={onSelectedSessionChange}
                onSelectTask={(taskId) =>
                    setSelectedTasks((current) => {
                        const next = { ...current };
                        if (taskId === undefined) {
                            delete next[selectedSessionKey];
                        } else {
                            next[selectedSessionKey] = taskId;
                        }
                        return next;
                    })
                }
                onSend={() => void send()}
                onSendSettingsChange={(settings) => void updateProviderSettings(settings)}
                onStartVoiceInput={speech.startVoiceInput}
                onStopReadAloud={speech.stopReadAloud}
                onStopVoiceInput={speech.stopVoiceInput}
                readAloud={speech.readAloud}
                selectedTaskId={selectedTaskId}
                sendSettings={currentSendSettings}
                taskCancelGatedIds={taskCancelGatedIds}
                view={view}
                voiceInput={speech.voiceInput}
            />
        </>
    );
}
