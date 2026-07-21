import {
    OpenClawChatRequestBoundaries,
    type OpenClawChatRequestBoundaryMetadata,
} from "./openClawChatRequestBoundaries.ts";

/** A minimal session shape used to recover missing session keys on runtime events. */
export interface OpenClawChatSessionIdentity {
    id: string;
    key: string;
    runId?: string;
    activeRunId?: string;
    currentRunId?: string;
}

/** A sequenced OpenClaw runtime envelope forwarded to Dashboard clients. */
export interface OpenClawRuntimeEnvelope {
    type: "event";
    event: unknown;
    payload: unknown;
    runtimeRecordedAt: number;
    runtimeSequence: number;
}

export interface OpenClawRuntimeSnapshot {
    completed: boolean;
    events: OpenClawRuntimeEnvelope[];
    interruptedAtByRun?: Record<string, number>;
    pendingRequestBoundaries?: Record<string, number>;
    requestBoundary?: number;
    throughSequence: number;
}

/** Storage boundary for the latest bounded replay of each chat session. */
export interface OpenClawChatSnapshotStore {
    clear(): void;
    delete(sessionKey: string): void;
    keys(): string[];
    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined;
    maximumSequence(): number;
    promote(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): void;
    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void;
}

interface OpenClawChatBridgeOptions {
    maxReplayBytes?: number;
}

interface RetainedRun {
    completed: boolean;
    eventBytes: number[];
    events: OpenClawRuntimeEnvelope[];
    interruptionEligible: boolean;
    interruptedAt?: number;
    runId: string;
    terminalSequence: number;
    totalBytes: number;
    updatedAt: number;
}

interface RepairedInterruptedRun {
    providerRunId: string;
    provisionalRunId: string;
}

const MAX_EVENTS_PER_ACTIVE_RUN = 20_000;
const MAX_BYTES_PER_ACTIVE_RUN = 64_000_000;
const MAX_BYTES_PER_EVENT = 1_000_000;
const MAX_RUNS_PER_SESSION = 4;
const MAX_BYTES_ACROSS_REPLAY = MAX_BYTES_PER_ACTIVE_RUN * MAX_RUNS_PER_SESSION;
export const MAX_CHAT_RUNTIME_SESSIONS = 50;
const MAX_RUN_ASSOCIATIONS = 200;
const ACTIVE_RUN_TTL_MS = 6 * 60 * 60_000;
const INTERRUPTED_RUN_PROMOTION_WINDOW_MS = 15 * 60_000;
const PERSIST_DEBOUNCE_MS = 250;
const SESSION_ECHO_WINDOW_MS = 60_000;
const TERMINAL_FAILURE_STATES = new Set(["aborted", "error", "failed"]);
const COMPACTION_TERMINAL_STATES = new Set([
    "aborted",
    "complete",
    "completed",
    "end",
    "error",
    "failed",
    "failure",
    "finished",
]);
const RETAINED_EVENTS = new Set([
    "agent",
    "chat",
    "model.completed",
    "session.ended",
    "session.compaction",
    "session.message",
    "session.started",
    "session.tool",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function stringField(
    record: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const value = record?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Returns the later defined timestamp without inventing a fallback value. */
function latestOptionalTimestamp(
    left: number | undefined,
    right: number | undefined
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

/** Uses the same nested event-data precedence as the browser runtime adapter. */
function runtimePayloadView(payload: unknown): Record<string, unknown> | undefined {
    const record = asRecord(payload);
    if (!record) {
        return undefined;
    }
    const data = asRecord(record.data);
    return data ? { ...record, ...data } : record;
}

/** Makes nested runtime identities available at the envelope boundary as well. */
function withRuntimeIdentity(
    payload: Record<string, unknown>,
    {
        runId,
        sessionKey,
        shouldRemoveSessionKey = false,
    }: {
        runId?: string;
        sessionKey?: string;
        shouldRemoveSessionKey?: boolean;
    }
): Record<string, unknown> {
    const normalized = { ...payload };
    if (runId) {
        normalized.runId = runId;
    }
    if (shouldRemoveSessionKey) {
        delete normalized.sessionKey;
    } else if (sessionKey) {
        normalized.sessionKey = sessionKey;
    }

    const data = asRecord(payload.data);
    if (!data) {
        return normalized;
    }
    const normalizedData = { ...data };
    if (runId && Object.hasOwn(data, "runId")) {
        normalizedData.runId = runId;
    }
    if (shouldRemoveSessionKey) {
        delete normalizedData.sessionKey;
    } else if (sessionKey && Object.hasOwn(data, "sessionKey")) {
        normalizedData.sessionKey = sessionKey;
    }
    normalized.data = normalizedData;
    return normalized;
}

function nestedRuntimeItem(
    data: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    return asRecord(data?.item) || asRecord(data?.payload) || data;
}

function hasRuntimeItemText(
    data: Record<string, unknown>,
    item: Record<string, unknown>
): boolean {
    return ["delta", "progressText", "summary", "text", "meta", "content"].some((key) => {
        const value = data[key] ?? item[key];
        return Array.isArray(value)
            ? value.length > 0
            : value !== undefined && value !== null && value !== "";
    });
}

function shouldRetainRuntimeEvent(
    event: unknown,
    payload: Record<string, unknown>
): boolean {
    if (event === "session.started" && !stringField(payload, "runId")) {
        return false;
    }
    if (event !== "agent") {
        return true;
    }
    const data = runtimePayloadView(payload);
    const stream = stringField(data, "stream") || "";
    if (stream.startsWith("codex_app_server.")) {
        return false;
    }
    if (stream !== "item" || !data) {
        return true;
    }
    const item = nestedRuntimeItem(data) || data;
    const phase = stringField(data, "phase") || stringField(item, "phase") || "";
    const kind = (
        stringField(item, "kind") ||
        stringField(item, "type") ||
        stringField(data, "kind") ||
        ""
    ).toLowerCase();
    if (kind === "command" && data.suppressChannelProgress === true) {
        // Native Codex commands are followed by richer session.tool events with
        // the same item ID. Retaining both lifecycle pairs turns one visible
        // tool bubble into four replay events and prematurely evicts thinking.
        return false;
    }
    return (
        !["start", "end"].includes(phase) ||
        !/\b(?:analysis|reasoning|thinking)\b/u.test(kind) ||
        hasRuntimeItemText(data, item)
    );
}

function replayToolData(
    envelope: OpenClawRuntimeEnvelope
): Record<string, unknown> | undefined {
    const payload = asRecord(envelope.payload);
    const data = runtimePayloadView(payload);
    if (
        envelope.event === "session.tool" ||
        (envelope.event === "agent" && stringField(data, "stream") === "tool")
    ) {
        return data;
    }
    return undefined;
}

function replayToolIdentifier(
    data: Record<string, unknown> | undefined
): string | undefined {
    return (
        stringField(data, "toolCallId") ||
        stringField(data, "callId") ||
        stringField(data, "itemId") ||
        stringField(data, "id")
    );
}

function replayCoalescingKey(envelope: OpenClawRuntimeEnvelope): string | undefined {
    const toolData = replayToolData(envelope);
    if (toolData) {
        const itemId = replayToolIdentifier(toolData);
        return itemId ? `${String(envelope.event)}:tool:${itemId}` : undefined;
    }
    if (envelope.event !== "agent") {
        return undefined;
    }
    const data = runtimePayloadView(envelope.payload);
    if (!data || stringField(data, "stream") !== "item") {
        return undefined;
    }
    const item = nestedRuntimeItem(data) || data;
    const phase = stringField(data, "phase") || stringField(item, "phase");
    if (phase !== "update" || data.delta !== undefined || item.delta !== undefined) {
        return undefined;
    }
    const itemId = stringField(data, "itemId") || stringField(item, "itemId");
    return itemId ? `agent:item:${itemId}` : undefined;
}

function coalesceReplayEnvelope(
    previous: OpenClawRuntimeEnvelope,
    next: OpenClawRuntimeEnvelope
): OpenClawRuntimeEnvelope {
    if (!replayToolData(previous) || !replayToolData(next)) {
        return next;
    }
    const previousPayload = asRecord(previous.payload) || {};
    const nextPayload = asRecord(next.payload) || {};
    const previousData = asRecord(previousPayload.data) || previousPayload;
    const nextData = asRecord(nextPayload.data) || nextPayload;
    return {
        ...next,
        payload: {
            ...previousPayload,
            ...nextPayload,
            data: { ...previousData, ...nextData },
        },
    };
}

const TRANSCRIPT_BACKED_ITEM_KINDS = new Set([
    "command",
    "custom_tool_call",
    "custom_tool_call_output",
    "function_call",
    "function_call_output",
    "tool_call",
    "tool_call_output",
    "tool_result",
    "tool_use",
    "toolcall",
    "toolresult",
]);

function isTranscriptBackedToolEnvelope(envelope: OpenClawRuntimeEnvelope): boolean {
    if (replayToolData(envelope)) {
        return true;
    }
    if (envelope.event !== "agent") {
        return false;
    }
    const data = runtimePayloadView(envelope.payload);
    if (!data || stringField(data, "stream") !== "item") {
        return false;
    }
    const item = nestedRuntimeItem(data) || data;
    const kind = (
        stringField(item, "kind") ||
        stringField(item, "type") ||
        stringField(data, "kind") ||
        ""
    ).toLowerCase();
    return TRANSCRIPT_BACKED_ITEM_KINDS.has(kind);
}

function trimRetainedRun(run: RetainedRun): void {
    while (
        run.events.length > 1 &&
        (run.events.length > MAX_EVENTS_PER_ACTIVE_RUN ||
            run.totalBytes > MAX_BYTES_PER_ACTIVE_RUN)
    ) {
        const transcriptBackedIndex = run.events.findIndex((event) =>
            isTranscriptBackedToolEnvelope(event)
        );
        const removalIndex = transcriptBackedIndex === -1 ? 0 : transcriptBackedIndex;
        run.events.splice(removalIndex, 1);
        run.totalBytes -= run.eventBytes.splice(removalIndex, 1)[0] || 0;
    }
}

function compactCompletedRun(run: RetainedRun): void {
    const retainedEvents = run.events.filter(
        (event) => !isTranscriptBackedToolEnvelope(event)
    );
    if (retainedEvents.length === run.events.length) {
        return;
    }
    run.events = retainedEvents;
    run.eventBytes = retainedEvents.map((event) =>
        Buffer.byteLength(JSON.stringify(event))
    );
    run.totalBytes = run.eventBytes.reduce((total, bytes) => total + bytes, 0);
}

function hasRunIdentifier(session: OpenClawChatSessionIdentity, runId: string): boolean {
    return [
        session.id,
        session.key,
        session.runId,
        session.activeRunId,
        session.currentRunId,
    ].includes(runId);
}

function isAgentSessionKey(sessionKey: string): boolean {
    return /^agent:[^:]+:.+$/iu.test(sessionKey.trim());
}

function normalizedSessionKey(sessionKey: string): string {
    return sessionKey.trim().toLowerCase();
}

function isExactSessionKey(left: string, right: string): boolean {
    return normalizedSessionKey(left) === normalizedSessionKey(right);
}

function isSameSessionKey(left: string, right: string): boolean {
    const normalizedLeft = normalizedSessionKey(left);
    const normalizedRight = normalizedSessionKey(right);
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    const leftMatch = normalizedLeft.match(/^agent:([^:]+):(.+)$/u);
    const rightMatch = normalizedRight.match(/^agent:([^:]+):(.+)$/u);
    if (leftMatch && rightMatch) {
        return leftMatch[1] === rightMatch[1] && leftMatch[2] === rightMatch[2];
    }
    return leftMatch
        ? leftMatch[2] === normalizedRight
        : rightMatch?.[2] === normalizedLeft;
}

function isAgentCompactionEvent(event: unknown, payload: unknown): boolean {
    const record = asRecord(payload);
    const data = asRecord(record?.data);
    const stream = stringField(data, "stream") || stringField(record, "stream");
    return event === "agent" && stream?.toLowerCase() === "compaction";
}

function isCompactionEvent(event: unknown, payload: unknown): boolean {
    return event === "session.compaction" || isAgentCompactionEvent(event, payload);
}

function isSettlingLifecycleEvent(event: unknown, payload: unknown): boolean {
    const record = runtimePayloadView(payload);
    const stream = (stringField(record, "stream") || "").toLowerCase();
    const phase = (stringField(record, "phase") || "").toLowerCase();
    return (
        event === "agent" && stream === "lifecycle" && ["end", "error"].includes(phase)
    );
}

function isStartingLifecycleEvent(event: unknown, payload: unknown): boolean {
    if (event === "session.started") {
        return true;
    }
    const record = runtimePayloadView(payload);
    const stream = (stringField(record, "stream") || "").toLowerCase();
    const phase = (stringField(record, "phase") || "").toLowerCase();
    return (
        event === "agent" &&
        stream === "lifecycle" &&
        ["start", "started"].includes(phase)
    );
}

function isCompactionOnlyRun(run: RetainedRun): boolean {
    return (
        run.events.length > 0 &&
        run.events.every((event) => isCompactionEvent(event.event, event.payload))
    );
}

function matchingSessionKeys(
    sessionKey: string,
    sessions: readonly OpenClawChatSessionIdentity[]
): Map<string, string> {
    const matches = new Map<string, string>();
    for (const session of sessions) {
        if (isSameSessionKey(session.key, sessionKey)) {
            matches.set(normalizedSessionKey(session.key), session.key);
        }
    }
    return matches;
}

function isTerminalEvent(event: unknown, payload: unknown): boolean {
    if (event === "model.completed" || event === "session.ended") {
        return true;
    }

    const record = runtimePayloadView(payload);
    const compactionOperation = (stringField(record, "operation") || "").toLowerCase();
    const eventPhase = (stringField(record, "phase") || "").toLowerCase();
    const eventStatus = (stringField(record, "status") || "").toLowerCase();
    const isRetryingCompaction =
        record?.willRetry === true ||
        eventPhase === "retrying" ||
        eventStatus === "retrying";
    const isTerminalCompaction =
        ((event === "session.compaction" && compactionOperation === "compact") ||
            isAgentCompactionEvent(event, payload)) &&
        !isRetryingCompaction &&
        (COMPACTION_TERMINAL_STATES.has(eventPhase) ||
            COMPACTION_TERMINAL_STATES.has(eventStatus));
    return (
        (event === "chat" &&
            ["aborted", "error", "final"].includes(
                (stringField(record, "state") || "").toLowerCase()
            )) ||
        (event === "session.message" &&
            sessionMessageRole(payload) === "assistant" &&
            sessionMessageStopReason(payload) === "stop") ||
        isTerminalCompaction ||
        isSettlingLifecycleEvent(event, payload)
    );
}

function compactTerminalPayload(
    payload: Record<string, unknown> | undefined,
    runId: string | undefined,
    sessionKey: string
): Record<string, unknown> {
    const data = asRecord(payload?.data);
    const payloadView = runtimePayloadView(payload);
    const compactData = {
        aborted: data?.aborted === true ? true : undefined,
        completed: data?.completed === true ? true : undefined,
        error: stringField(data, "error"),
        errorMessage: stringField(data, "errorMessage"),
        operation: stringField(data, "operation"),
        operationId: stringField(data, "operationId"),
        phase: stringField(data, "phase"),
        promptError: stringField(data, "promptError"),
        state: stringField(data, "state"),
        status: stringField(data, "status"),
        stream: stringField(data, "stream"),
    };
    const hasCompactData = Object.values(compactData).some(
        (value) => value !== undefined
    );
    return {
        aborted: payloadView?.aborted === true ? true : undefined,
        completed: payloadView?.completed === true ? true : undefined,
        data: hasCompactData ? compactData : undefined,
        error: stringField(payloadView, "error"),
        errorMessage: stringField(payloadView, "errorMessage"),
        operation: stringField(payloadView, "operation"),
        operationId: stringField(payloadView, "operationId"),
        phase: stringField(payloadView, "phase"),
        promptError: stringField(payloadView, "promptError"),
        role: sessionMessageRole(payload),
        runId,
        sessionKey,
        state: stringField(payloadView, "state"),
        status: stringField(payloadView, "status"),
        stopReason: sessionMessageStopReason(payload),
        stream: stringField(payloadView, "stream"),
    };
}

function isProvisionalRunId(runId: string): boolean {
    return (
        isRunlessRunId(runId) ||
        runId.startsWith("dashboard-chat-") ||
        runId.startsWith("dashboard-compact-")
    );
}

function isRunlessRunId(runId: string): boolean {
    return runId === "runless" || /^runless:\d+$/u.test(runId);
}

function isMetadataOnlyCompletionEnvelope(envelope: OpenClawRuntimeEnvelope): boolean {
    if (envelope.event !== "session.ended" && envelope.event !== "model.completed") {
        return false;
    }
    const payload = asRecord(envelope.payload);
    const data = asRecord(payload?.data);
    const terminalStates = [
        stringField(payload, "state"),
        stringField(payload, "status"),
        stringField(data, "phase"),
        stringField(data, "status"),
    ].map((value) => value?.toLowerCase());
    return (
        payload?.aborted !== true &&
        data?.aborted !== true &&
        !stringField(payload, "error") &&
        !stringField(payload, "errorMessage") &&
        !stringField(payload, "promptError") &&
        !stringField(data, "error") &&
        !stringField(data, "errorMessage") &&
        !stringField(data, "promptError") &&
        payload?.message === undefined &&
        payload?.content === undefined &&
        payload?.text === undefined &&
        terminalStates.every((value) => !TERMINAL_FAILURE_STATES.has(value || ""))
    );
}

function isMetadataOnlyRunlessCompletion(run: RetainedRun): boolean {
    return (
        isRunlessRunId(run.runId) &&
        run.events.length > 0 &&
        run.events.every((event) => isMetadataOnlyCompletionEnvelope(event))
    );
}

function isAuxiliaryOnlyCompletion(run: RetainedRun): boolean {
    return isMetadataOnlyRunlessCompletion(run) || isCompactionOnlyRun(run);
}

function lastSequence(run: RetainedRun): number {
    return run.events.at(-1)?.runtimeSequence ?? -1;
}

function firstSequence(run: RetainedRun): number {
    return run.events[0]?.runtimeSequence ?? -1;
}

function latestRunUpdatedAt(runs: Iterable<RetainedRun>): number {
    let latest = -Infinity;
    for (const run of runs) {
        latest = Math.max(latest, run.updatedAt);
    }
    return latest;
}

function replayBytes(runs: Iterable<RetainedRun>): number {
    let bytes = 0;
    for (const run of runs) {
        bytes += run.totalBytes;
    }
    return bytes;
}

function oldestReplayBudgetSessionKey(
    sessions: ReadonlyMap<string, ReadonlyMap<string, RetainedRun>>,
    protectedSessionKey?: string
): string | undefined {
    let hasOldestActiveRun = true;
    let oldestSessionKey: string | undefined;
    let oldestUpdatedAt = Infinity;
    for (const [candidateSessionKey, runs] of sessions) {
        if (
            protectedSessionKey &&
            isSameSessionKey(candidateSessionKey, protectedSessionKey)
        ) {
            continue;
        }
        const hasActiveRun = runs.values().some((run) => !run.completed);
        const updatedAt = latestRunUpdatedAt(runs.values());
        if (
            oldestSessionKey === undefined ||
            (hasOldestActiveRun && !hasActiveRun) ||
            (hasOldestActiveRun === hasActiveRun && updatedAt < oldestUpdatedAt)
        ) {
            hasOldestActiveRun = hasActiveRun;
            oldestSessionKey = candidateSessionKey;
            oldestUpdatedAt = updatedAt;
        }
    }
    return oldestSessionKey;
}

function oldestEvictableSessionKey(
    sessions: ReadonlyMap<string, ReadonlyMap<string, RetainedRun>>,
    protectedSessionKey?: string
): string | undefined {
    let oldestSessionKey: string | undefined;
    let oldestUpdatedAt = Infinity;
    for (const [candidateSessionKey, runs] of sessions) {
        if (
            protectedSessionKey &&
            isSameSessionKey(candidateSessionKey, protectedSessionKey)
        ) {
            continue;
        }
        const updatedAt = latestRunUpdatedAt(runs.values());
        if (updatedAt < oldestUpdatedAt) {
            oldestSessionKey = candidateSessionKey;
            oldestUpdatedAt = updatedAt;
        }
    }
    return oldestSessionKey;
}

function normalizedMessageText(value: unknown): string {
    if (typeof value === "string") {
        return value.trim();
    }
    if (!Array.isArray(value)) {
        return "";
    }
    return value
        .map((block) => {
            if (typeof block === "string") {
                return block;
            }
            const record = asRecord(block);
            if (["thinking", "toolCall"].includes(String(record?.type))) {
                return "";
            }
            return typeof record?.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function messageSignature(payload: unknown): string | undefined {
    const record = runtimePayloadView(payload);
    if (!record) {
        return undefined;
    }
    const message = asRecord(record.message);
    const candidates = message
        ? [message.text, message.content]
        : [record.message, record.content, record.text];
    for (const candidate of candidates) {
        const text = normalizedMessageText(candidate);
        if (text) {
            return `text:${text}`;
        }
    }
    for (const candidate of candidates) {
        if (
            candidate === undefined ||
            candidate === null ||
            candidate === "" ||
            (Array.isArray(candidate) && candidate.length === 0)
        ) {
            continue;
        }
        try {
            const serialized = JSON.stringify(candidate);
            if (serialized) {
                return `content:${serialized}`;
            }
        } catch {
            return undefined;
        }
    }
    return undefined;
}

function hasChatFinal(run: RetainedRun): boolean {
    return run.events.some(
        (candidate) =>
            candidate.event === "chat" &&
            (
                stringField(runtimePayloadView(candidate.payload), "state") || ""
            ).toLowerCase() === "final"
    );
}

function sessionMessageRole(payload: unknown): string | undefined {
    const record = runtimePayloadView(payload);
    return (
        stringField(record, "role") || stringField(asRecord(record?.message), "role")
    )?.toLowerCase();
}

function sessionMessageStopReason(payload: unknown): string | undefined {
    const record = runtimePayloadView(payload);
    const message = asRecord(record?.message);
    return (
        stringField(message, "stopReason") || stringField(record, "stopReason")
    )?.toLowerCase();
}

function sessionMessageRunId(event: unknown, payload: unknown): string | undefined {
    if (event !== "session.message" || sessionMessageRole(payload) !== "user") {
        return undefined;
    }
    const record = runtimePayloadView(payload);
    const activeRunIds = sessionMessageActiveRunIds(payload);
    const providerRunIds = [...new Set(activeRunIds)].filter(
        (runId) => !isProvisionalRunId(runId)
    );
    if (providerRunIds.length === 1) {
        return providerRunIds[0];
    }
    const idempotencyKey = stringField(asRecord(record?.message), "idempotencyKey");
    return idempotencyKey?.match(/^(dashboard-chat-.+):user$/u)?.[1];
}

function sessionMessageActiveRunIds(payload: unknown): string[] {
    const activeRunIds = runtimePayloadView(payload)?.activeRunIds;
    return Array.isArray(activeRunIds)
        ? [
              ...new Set(
                  activeRunIds.filter(
                      (runId): runId is string =>
                          typeof runId === "string" && runId.trim().length > 0
                  )
              ),
          ]
        : [];
}

function sessionMessageRequestId(event: unknown, payload: unknown): string | undefined {
    if (event !== "session.message" || sessionMessageRole(payload) !== "user") {
        return undefined;
    }
    const message = asRecord(runtimePayloadView(payload)?.message);
    return stringField(message, "idempotencyKey")?.match(/^(.+):user$/u)?.[1];
}

function isRunlessUserLedRun(run: RetainedRun): boolean {
    const firstEvent = run.events[0];
    return (
        !run.completed &&
        isRunlessRunId(run.runId) &&
        firstEvent?.event === "session.message" &&
        sessionMessageRole(firstEvent.payload) === "user"
    );
}

function isPromotableRunlessUserLedRun(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope,
    runs: ReadonlyMap<string, RetainedRun>
): boolean {
    if (isRunlessUserLedRun(run)) {
        return true;
    }
    const firstEvent = run.events[0];
    const terminalEvent = run.events.find(
        (event) => event.runtimeSequence === run.terminalSequence
    );
    const isLatestSessionRun = runs
        .values()
        .every((candidate) => lastSequence(candidate) <= lastSequence(run));
    const isLatestCompletedSyntheticTurn = Boolean(
        isLatestSessionRun &&
        run.completed &&
        isRunlessRunId(run.runId) &&
        firstEvent?.event === "session.message" &&
        sessionMessageRole(firstEvent.payload) === "user" &&
        terminalEvent?.event === "session.message" &&
        sessionMessageRole(terminalEvent.payload) === "assistant" &&
        sessionMessageStopReason(terminalEvent.payload) === "stop" &&
        envelope.runtimeSequence > run.terminalSequence
    );
    if (!isLatestCompletedSyntheticTurn || !terminalEvent) {
        return false;
    }
    if (isMetadataOnlyCompletionEnvelope(envelope)) {
        return true;
    }
    const terminalSignature = messageSignature(terminalEvent.payload);
    return Boolean(
        terminalSignature && terminalSignature === messageSignature(envelope.payload)
    );
}

function isPromotableInterruptedDashboardRun(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope,
    runs: ReadonlyMap<string, RetainedRun>,
    requestBoundary?: number,
    providerRun?: RetainedRun
): boolean {
    const providerRunId = stringField(runtimePayloadView(envelope.payload), "runId");
    const resumeDelay = envelope.runtimeRecordedAt - (run.interruptedAt ?? run.updatedAt);
    if (
        !providerRunId ||
        resumeDelay < -5000 ||
        resumeDelay > INTERRUPTED_RUN_PROMOTION_WINDOW_MS ||
        run.completed ||
        !run.interruptionEligible ||
        !run.runId.startsWith("dashboard-chat-") ||
        isProvisionalRunId(providerRunId) ||
        !isStartingLifecycleEvent(envelope.event, envelope.payload) ||
        envelope.runtimeSequence <= lastSequence(run) ||
        (requestBoundary !== undefined && firstSequence(run) <= requestBoundary)
    ) {
        return false;
    }

    return runs
        .values()
        .every(
            (candidate) =>
                candidate === run ||
                candidate === providerRun ||
                candidate.completed ||
                isCompactionOnlyRun(candidate)
        );
}

function isMatchingSessionEcho(
    run: RetainedRun,
    envelope: OpenClawRuntimeEnvelope
): boolean {
    const role = sessionMessageRole(envelope.payload);
    if (role && role !== "assistant") {
        return false;
    }
    const elapsedMilliseconds = envelope.runtimeRecordedAt - run.updatedAt;
    if (elapsedMilliseconds < -5000 || elapsedMilliseconds > SESSION_ECHO_WINDOW_MS) {
        return false;
    }
    const signature = messageSignature(envelope.payload);
    return Boolean(
        signature &&
        run.events.some(
            (candidate) =>
                candidate.event === "chat" &&
                (
                    stringField(runtimePayloadView(candidate.payload), "state") || ""
                ).toLowerCase() === "final" &&
                messageSignature(candidate.payload) === signature
        )
    );
}

/**
 * Quarantines the OpenClaw-specific runtime replay contract behind one backend
 * boundary. Dashboard chat code consumes this bridge instead of owning cache,
 * alias, retention, and request-cleanup rules inside the generic Gateway relay.
 */
export class OpenClawChatBridge {
    readonly #hydratedSessionLookups = new Set<string>();
    readonly #loadedStoreKeys = new Set<string>();
    readonly #pendingDeleteKeys = new Set<string>();
    readonly #pendingPersistence = new Set<string>();
    readonly #pendingSessionClears = new Set<string>();
    readonly #runsBySession = new Map<string, Map<string, RetainedRun>>();
    readonly #requestBoundaries = new OpenClawChatRequestBoundaries(
        normalizedSessionKey,
        isSameSessionKey
    );
    readonly #sessionsByRun = new Map<string, Set<string>>();
    readonly #maxReplayBytes: number;
    readonly #store: OpenClawChatSnapshotStore | undefined;
    #enforcingReplayMemoryLimit = false;
    #persistenceTimer: ReturnType<typeof setTimeout> | undefined;
    #replayMemoryLimitDeferrals = 0;
    #sequence = 0;
    #sequenceHydrated = false;
    #sessionLimitDeferrals = 0;
    #storeClearPending = false;
    #storeFailureReported = false;
    #totalReplayBytes = 0;

    constructor(
        store?: OpenClawChatSnapshotStore,
        options: OpenClawChatBridgeOptions = {}
    ) {
        const maxReplayBytes = options.maxReplayBytes ?? MAX_BYTES_ACROSS_REPLAY;
        if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes <= 0) {
            throw new Error("Replay memory limit must be a positive safe integer");
        }
        this.#maxReplayBytes = maxReplayBytes;
        this.#store = store;
        if (!store) {
            this.#sequenceHydrated = true;
            return;
        }
        this.#tryHydrateSequence();
    }

    #tryHydrateSequence(): boolean {
        if (this.#sequenceHydrated) {
            return true;
        }
        if (!this.#store) {
            this.#sequenceHydrated = true;
            return true;
        }
        try {
            const maximumSequence = this.#store.maximumSequence();
            if (!Number.isSafeInteger(maximumSequence) || maximumSequence < 0) {
                throw new Error("Runtime snapshot sequence watermark is invalid");
            }
            this.#sequence = maximumSequence;
            this.#sequenceHydrated = true;
            this.#storeFailureReported = false;
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #requireSequenceHydrated(): void {
        if (!this.#tryHydrateSequence()) {
            throw new Error("Runtime snapshot sequence watermark is unavailable");
        }
    }

    #reportStoreFailure(error: unknown): void {
        if (this.#storeFailureReported) {
            return;
        }
        this.#storeFailureReported = true;
        console.warn(
            "[OpenClawChatBridge] Runtime snapshot persistence failed:",
            error instanceof Error ? error.message : String(error)
        );
    }

    #withDeferredSessionLimit<T>(operation: () => T): T {
        this.#sessionLimitDeferrals += 1;
        try {
            return operation();
        } finally {
            this.#sessionLimitDeferrals -= 1;
        }
    }

    #cancelPersistenceTimer(): void {
        if (!this.#persistenceTimer) {
            return;
        }
        clearTimeout(this.#persistenceTimer);
        this.#persistenceTimer = undefined;
    }

    #retryStoreClear(): boolean {
        if (!this.#store || !this.#storeClearPending) {
            return true;
        }
        try {
            this.#store.clear();
            this.#storeClearPending = false;
            this.#pendingDeleteKeys.clear();
            this.#pendingSessionClears.clear();
            this.#loadedStoreKeys.clear();
            this.#storeFailureReported = false;
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #storedSessionKeys(): string[] | undefined {
        if (!this.#store) {
            return [];
        }
        if (!this.#retryStoreClear()) {
            return undefined;
        }
        try {
            const keys = this.#store.keys();
            this.#storeFailureReported = false;
            return keys;
        } catch (error) {
            this.#reportStoreFailure(error);
            return undefined;
        }
    }

    #hasPendingExactDelete(sessionKey: string): boolean {
        return this.#pendingDeleteKeys
            .values()
            .some((candidate) => isExactSessionKey(candidate, sessionKey));
    }

    #retryExactDelete(sessionKey: string): boolean {
        if (!this.#store || !this.#hasPendingExactDelete(sessionKey)) {
            return true;
        }
        let hasFailed = false;
        for (const pendingKey of this.#pendingDeleteKeys) {
            if (!isExactSessionKey(pendingKey, sessionKey)) {
                continue;
            }
            try {
                this.#store.delete(pendingKey);
                this.#pendingDeleteKeys.delete(pendingKey);
                this.#loadedStoreKeys.delete(pendingKey);
                this.#storeFailureReported = false;
            } catch (error) {
                hasFailed = true;
                this.#reportStoreFailure(error);
            }
        }
        return !hasFailed;
    }

    #retryPendingSessionClear(sessionKey: string): boolean {
        if (
            !this.#store ||
            this.#pendingSessionClears
                .values()
                .every((candidate) => !isSameSessionKey(candidate, sessionKey))
        ) {
            return true;
        }
        const storedKeys = this.#storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const matchingKeys = new Set(
            [
                ...this.#pendingSessionClears.values(),
                ...this.#pendingDeleteKeys.values(),
                ...storedKeys.filter((candidate) =>
                    isSameSessionKey(candidate, sessionKey)
                ),
            ].filter((candidate) => isSameSessionKey(candidate, sessionKey))
        );
        let hasFailed = false;
        for (const matchingKey of matchingKeys) {
            try {
                this.#store.delete(matchingKey);
                this.#pendingDeleteKeys.delete(matchingKey);
                this.#loadedStoreKeys.delete(matchingKey);
                this.#storeFailureReported = false;
            } catch (error) {
                hasFailed = true;
                this.#reportStoreFailure(error);
            }
        }
        if (hasFailed) {
            return false;
        }
        for (const pendingKey of this.#pendingDeleteKeys) {
            if (isSameSessionKey(pendingKey, sessionKey)) {
                this.#pendingDeleteKeys.delete(pendingKey);
            }
        }
        for (const pendingClear of this.#pendingSessionClears) {
            if (isSameSessionKey(pendingClear, sessionKey)) {
                this.#pendingSessionClears.delete(pendingClear);
            }
        }
        return true;
    }

    #ensureSessionLoaded(sessionKey: string): boolean {
        if (!this.#store) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        if (
            !this.#retryPendingSessionClear(storageSessionKey) ||
            !this.#retryExactDelete(storageSessionKey)
        ) {
            return false;
        }
        if (this.#hydratedSessionLookups.has(storageSessionKey)) {
            return true;
        }
        const storedKeys = this.#storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const exactKey = storedKeys.find((candidate) =>
            isExactSessionKey(candidate, storageSessionKey)
        );
        const matchingKeys = exactKey
            ? [exactKey]
            : storedKeys.filter((candidate) =>
                  isSameSessionKey(candidate, storageSessionKey)
              );
        if (matchingKeys.length === 0) {
            this.#hydratedSessionLookups.add(storageSessionKey);
            return true;
        }
        if (matchingKeys.length !== 1) {
            return false;
        }
        const storedKey = matchingKeys[0]!;
        const storedStorageKey = normalizedSessionKey(storedKey);
        if (this.#hasPendingExactDelete(storedKey)) {
            return (
                this.#retryExactDelete(storedKey) && this.#ensureSessionLoaded(sessionKey)
            );
        }
        this.#hydratedSessionLookups.add(storageSessionKey);
        if (this.#loadedStoreKeys.has(storedStorageKey)) {
            const requiresCanonicalPromotion =
                storedStorageKey !== storageSessionKey &&
                isAgentSessionKey(storageSessionKey);
            if (
                requiresCanonicalPromotion &&
                !this.#promoteSessionEntry(
                    storedStorageKey,
                    storageSessionKey,
                    undefined,
                    storageSessionKey
                )
            ) {
                this.#hydratedSessionLookups.delete(storageSessionKey);
                return false;
            }
            return true;
        }
        let snapshot: OpenClawRuntimeSnapshot | undefined;
        try {
            snapshot = this.#store.load(storedKey);
            this.#storeFailureReported = false;
        } catch (error) {
            this.#hydratedSessionLookups.delete(storageSessionKey);
            this.#reportStoreFailure(error);
            return false;
        }
        this.#loadedStoreKeys.add(storedStorageKey);
        if (!snapshot) {
            return true;
        }
        this.#sequence = Math.max(this.#sequence, snapshot.throughSequence);
        this.#requestBoundaries.restore(storedStorageKey, snapshot);
        const sortedEvents = snapshot.events.toSorted(
            (left, right) => left.runtimeSequence - right.runtimeSequence
        );
        this.#withDeferredSessionLimit(() => {
            for (const envelope of sortedEvents) {
                this.#sequence = Math.max(this.#sequence, envelope.runtimeSequence);
                this.#retain(envelope, false);
            }
        });
        const hydratedRuns = this.#runsBySession.get(storedStorageKey);
        const interruptedRunEntries = Object.entries(snapshot.interruptedAtByRun || {});
        for (const [runId, interruptedAt] of interruptedRunEntries) {
            const hydratedRun = hydratedRuns?.get(runId);
            if (!hydratedRun) {
                continue;
            }
            hydratedRun.interruptionEligible = true;
            hydratedRun.interruptedAt = interruptedAt;
        }
        const prunedStaleRun = this.#pruneStaleActiveRuns(storedStorageKey);
        if (prunedStaleRun && !this.#runsBySession.has(storedStorageKey)) {
            const didPersist = this.#flushSessionPersistence(storedStorageKey);
            if (!didPersist) {
                this.#hydratedSessionLookups.delete(storageSessionKey);
            }
            this.#enforceSessionLimit(storageSessionKey);
            return didPersist;
        }
        if (
            storedStorageKey !== storageSessionKey &&
            isAgentSessionKey(storageSessionKey)
        ) {
            if (
                !this.#promoteSessionEntry(
                    storedStorageKey,
                    storageSessionKey,
                    undefined,
                    storageSessionKey
                )
            ) {
                this.#hydratedSessionLookups.delete(storageSessionKey);
                this.#enforceSessionLimit(storedStorageKey);
                return false;
            }
            return true;
        }
        this.#enforceSessionLimit(storedStorageKey);
        if (prunedStaleRun && !this.#flushSessionPersistence(storedStorageKey)) {
            this.#hydratedSessionLookups.delete(storageSessionKey);
            return false;
        }
        return true;
    }

    #pruneStaleActiveRuns(sessionKey: string, now = Date.now()): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return false;
        }
        let hasChanged = false;
        for (const [runId, run] of runs) {
            // Completed replay is the durable "last run" view and is intentionally
            // retained until a successful new send replaces it. The TTL only
            // recovers abandoned active runs after a missing lifecycle end.
            const latestActivityAt = Math.max(
                run.updatedAt,
                run.interruptedAt ?? -Infinity
            );
            if (run.completed || now - latestActivityAt <= ACTIVE_RUN_TTL_MS) {
                continue;
            }
            runs.delete(runId);
            this.#forgetRunSession(runId, sessionKey);
            hasChanged = true;
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(storageSessionKey);
        }
        if (hasChanged) {
            this.#refreshTotalReplayBytes();
        }
        return hasChanged;
    }

    #snapshotFromRuns(
        runs: ReadonlyMap<string, RetainedRun> | undefined,
        shouldIncludePersistenceMetadata = false,
        requestBoundaries: OpenClawChatRequestBoundaryMetadata = {}
    ): OpenClawRuntimeSnapshot {
        const snapshots = runs ? runs.values().toArray() : [];
        const active = snapshots.filter((snapshot) => !snapshot.completed);
        const completed = snapshots
            .filter((snapshot) => snapshot.completed)
            .toSorted((left, right) => right.terminalSequence - left.terminalSequence);
        const newestCompleted = completed[0];
        const latestConversation = completed.find(
            (snapshot) => !isAuxiliaryOnlyCompletion(snapshot)
        );
        const completedToReplay = latestConversation || newestCompleted;
        const activeConversation = active.filter(
            (snapshot) => !isCompactionOnlyRun(snapshot)
        );
        let selected: RetainedRun[];
        if (activeConversation.length > 0) {
            selected = active;
        } else if (active.length > 0) {
            selected = latestConversation ? [latestConversation, ...active] : active;
        } else {
            selected = completedToReplay ? [completedToReplay] : [];
        }

        const interruptedAtByRun = shouldIncludePersistenceMetadata
            ? Object.fromEntries(
                  selected.flatMap((snapshot) =>
                      snapshot.interruptedAt === undefined
                          ? []
                          : [[snapshot.runId, snapshot.interruptedAt]]
                  )
              )
            : {};

        return {
            completed: active.length === 0 && selected.length > 0,
            events: selected
                .flatMap((snapshot) => snapshot.events)
                .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence),
            ...(Object.keys(interruptedAtByRun).length > 0 && {
                interruptedAtByRun,
            }),
            ...(shouldIncludePersistenceMetadata && requestBoundaries),
            throughSequence: this.#sequence,
        };
    }

    #snapshotFromMemory(
        sessionKey: string,
        shouldIncludePersistenceMetadata = false
    ): OpenClawRuntimeSnapshot {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        return this.#snapshotFromRuns(
            this.#runsBySession.get(storageSessionKey),
            shouldIncludePersistenceMetadata,
            shouldIncludePersistenceMetadata
                ? this.#requestBoundaries.metadata(storageSessionKey)
                : {}
        );
    }

    #deletePersistedSession(sessionKey: string): boolean {
        if (!this.#store) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        this.#pendingDeleteKeys.add(storageSessionKey);
        try {
            this.#store.delete(storageSessionKey);
            this.#pendingDeleteKeys.delete(storageSessionKey);
            this.#loadedStoreKeys.delete(storageSessionKey);
            this.#storeFailureReported = false;
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #persistSession(sessionKey: string): boolean {
        if (!this.#store) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        if (
            !this.#retryStoreClear() ||
            !this.#retryPendingSessionClear(storageSessionKey) ||
            !this.#retryExactDelete(storageSessionKey) ||
            !this.#ensureSessionLoaded(storageSessionKey)
        ) {
            return false;
        }
        const snapshot = this.#snapshotFromMemory(storageSessionKey, true);
        try {
            if (snapshot.events.length === 0) {
                return this.#deletePersistedSession(storageSessionKey);
            }
            this.#store.save(storageSessionKey, snapshot);
            for (const pendingKey of this.#pendingDeleteKeys) {
                if (isExactSessionKey(pendingKey, storageSessionKey)) {
                    this.#pendingDeleteKeys.delete(pendingKey);
                }
            }
            this.#loadedStoreKeys.add(storageSessionKey);
            this.#storeFailureReported = false;
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #flushSessionPersistence(sessionKey: string): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const didPersist = this.#persistSession(storageSessionKey);
        if (didPersist) {
            this.#pendingPersistence.delete(storageSessionKey);
        } else {
            this.#pendingPersistence.add(storageSessionKey);
        }
        if (this.#pendingPersistence.size === 0) {
            this.#cancelPersistenceTimer();
        }
        return didPersist;
    }

    #flushPendingPersistence(): boolean {
        this.#cancelPersistenceTimer();
        const sessionKeys = this.#pendingPersistence.values().toArray();
        let didFlushAll = true;
        for (const sessionKey of sessionKeys) {
            didFlushAll = this.#flushSessionPersistence(sessionKey) && didFlushAll;
        }
        return didFlushAll;
    }

    #queuePersistence(sessionKey: string): void {
        if (!this.#store) {
            return;
        }
        this.#pendingPersistence.add(normalizedSessionKey(sessionKey));
        if (this.#persistenceTimer) {
            return;
        }
        this.#persistenceTimer = setTimeout(() => {
            this.#persistenceTimer = undefined;
            this.#flushPendingPersistence();
        }, PERSIST_DEBOUNCE_MS);
    }

    #evictSessionFromMemory(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const evictedBytes = replayBytes(
            this.#runsBySession.get(storageSessionKey)?.values() || []
        );
        this.#pendingPersistence.delete(storageSessionKey);
        if (this.#pendingPersistence.size === 0) {
            this.#cancelPersistenceTimer();
        }
        this.#runsBySession.delete(storageSessionKey);
        this.#requestBoundaries.forget(storageSessionKey);
        this.#totalReplayBytes = Math.max(0, this.#totalReplayBytes - evictedBytes);
        for (const runId of this.#sessionsByRun.keys()) {
            this.#forgetRunSession(runId, storageSessionKey);
        }
        this.#loadedStoreKeys.delete(storageSessionKey);
        for (const lookup of this.#hydratedSessionLookups) {
            if (isSameSessionKey(lookup, storageSessionKey)) {
                this.#hydratedSessionLookups.delete(lookup);
            }
        }
    }

    #clearCompletedRuns(sessionKey: string, preservedRunId?: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return;
        }
        for (const [runId, run] of runs) {
            if (runId === preservedRunId || !run.completed) {
                continue;
            }
            runs.delete(runId);
            this.#forgetRunSession(runId, storageSessionKey);
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(storageSessionKey);
        }
        this.#refreshTotalReplayBytes();
        this.#flushSessionPersistence(storageSessionKey);
    }

    #cloneRetainedRun(run: RetainedRun): RetainedRun {
        return {
            ...run,
            eventBytes: [...run.eventBytes],
            events: [...run.events],
        };
    }

    #ensureCanonicalDestinationLoaded(canonicalSessionKey: string): boolean {
        if (!this.#store) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(canonicalSessionKey);
        const storedKeys = this.#storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const storedCanonicalKey = storedKeys.find((candidate) =>
            isExactSessionKey(candidate, storageSessionKey)
        );
        const storedCanonicalStorageKey = storedCanonicalKey
            ? normalizedSessionKey(storedCanonicalKey)
            : undefined;
        if (
            !storedCanonicalKey ||
            (storedCanonicalStorageKey &&
                this.#loadedStoreKeys.has(storedCanonicalStorageKey))
        ) {
            return true;
        }
        this.#withDeferredSessionLimit(() =>
            this.#ensureSessionLoaded(storedCanonicalKey)
        );
        return Boolean(
            storedCanonicalStorageKey &&
            this.#loadedStoreKeys.has(storedCanonicalStorageKey)
        );
    }

    #persistSessionPromotion(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): boolean {
        if (!this.#store) {
            return true;
        }
        if (
            !this.#retryStoreClear() ||
            !this.#retryPendingSessionClear(sourceSessionKey) ||
            !this.#retryPendingSessionClear(canonicalSessionKey) ||
            !this.#retryExactDelete(sourceSessionKey) ||
            !this.#retryExactDelete(canonicalSessionKey)
        ) {
            return false;
        }
        try {
            this.#store.promote(
                sourceSessionKey,
                canonicalSessionKey,
                sourceSnapshot,
                canonicalSnapshot
            );
            for (const pendingKey of this.#pendingDeleteKeys) {
                if (
                    isExactSessionKey(pendingKey, sourceSessionKey) ||
                    isExactSessionKey(pendingKey, canonicalSessionKey)
                ) {
                    this.#pendingDeleteKeys.delete(pendingKey);
                }
            }
            if (sourceSnapshot.events.length === 0) {
                this.#loadedStoreKeys.delete(sourceSessionKey);
            } else {
                this.#loadedStoreKeys.add(sourceSessionKey);
            }
            if (canonicalSnapshot.events.length === 0) {
                this.#loadedStoreKeys.delete(canonicalSessionKey);
            } else {
                this.#loadedStoreKeys.add(canonicalSessionKey);
            }
            this.#hydratedSessionLookups.add(sourceSessionKey);
            this.#hydratedSessionLookups.add(canonicalSessionKey);
            this.#storeFailureReported = false;
            return true;
        } catch (error) {
            this.#reportStoreFailure(error);
            return false;
        }
    }

    #promoteSessionEntry(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        preferredRunId?: string,
        protectedSessionKey?: string
    ): boolean {
        const sourceStorageKey = normalizedSessionKey(sourceSessionKey);
        const canonicalStorageKey = normalizedSessionKey(canonicalSessionKey);
        if (sourceStorageKey === canonicalStorageKey) {
            return true;
        }
        if (!this.#ensureCanonicalDestinationLoaded(canonicalStorageKey)) {
            return false;
        }
        const sourceRuns = this.#runsBySession.get(sourceStorageKey);
        if (!sourceRuns || (preferredRunId && !sourceRuns.has(preferredRunId))) {
            return false;
        }
        const previousCanonicalRuns = this.#runsBySession.get(canonicalStorageKey);
        const nextSourceRuns = new Map(
            [...sourceRuns].map(([runId, run]) => [runId, this.#cloneRetainedRun(run)])
        );
        const nextCanonicalRuns = new Map(
            [...(previousCanonicalRuns || [])].map(([runId, run]) => [
                runId,
                this.#cloneRetainedRun(run),
            ])
        );
        const movedRunIds = new Set<string>();
        const runIds = preferredRunId
            ? [preferredRunId]
            : nextSourceRuns.keys().toArray();
        for (const runId of runIds) {
            const sourceRun = nextSourceRuns.get(runId);
            if (!sourceRun) {
                continue;
            }
            const rewrittenEvents = sourceRun.events.flatMap((envelope) => {
                const payload = asRecord(envelope.payload);
                const payloadView = runtimePayloadView(payload);
                if (
                    !payload ||
                    !isExactSessionKey(
                        stringField(payloadView, "sessionKey") || "",
                        sourceStorageKey
                    )
                ) {
                    return [envelope];
                }
                const rewritten = {
                    ...envelope,
                    payload: withRuntimeIdentity(payload, {
                        sessionKey: canonicalStorageKey,
                    }),
                };
                if (Buffer.byteLength(JSON.stringify(rewritten)) <= MAX_BYTES_PER_EVENT) {
                    return [rewritten];
                }
                if (!isTerminalEvent(envelope.event, rewritten.payload)) {
                    return [];
                }
                const compact = {
                    ...envelope,
                    payload: compactTerminalPayload(
                        asRecord(rewritten.payload),
                        stringField(payloadView, "runId"),
                        canonicalStorageKey
                    ),
                };
                return Buffer.byteLength(JSON.stringify(compact)) <= MAX_BYTES_PER_EVENT
                    ? [compact]
                    : [];
            });
            this.#replaceRunEvents(sourceRun, rewrittenEvents);
            movedRunIds.add(runId);
            if (sourceRun.events.length === 0) {
                nextSourceRuns.delete(runId);
                continue;
            }
            const existing = nextCanonicalRuns.get(runId);
            if (existing) {
                this.#replaceRunEvents(existing, [
                    ...existing.events,
                    ...sourceRun.events,
                ]);
                existing.completed ||= sourceRun.completed;
                existing.interruptionEligible ||= sourceRun.interruptionEligible;
                existing.interruptedAt = latestOptionalTimestamp(
                    existing.interruptedAt,
                    sourceRun.interruptedAt
                );
                existing.terminalSequence = Math.max(
                    existing.terminalSequence,
                    sourceRun.terminalSequence
                );
                existing.updatedAt = Math.max(existing.updatedAt, sourceRun.updatedAt);
            } else {
                nextCanonicalRuns.set(runId, sourceRun);
            }
            nextSourceRuns.delete(runId);
        }

        const repairedRunIdentity =
            nextSourceRuns.size === 0
                ? this.#repairInterruptedRunSplit(canonicalStorageKey, nextCanonicalRuns)
                : undefined;

        const evictedCanonicalRunIds = new Set<string>();
        while (nextCanonicalRuns.size > MAX_RUNS_PER_SESSION) {
            const oldestRunId = nextCanonicalRuns
                .values()
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
            if (!oldestRunId) {
                break;
            }
            nextCanonicalRuns.delete(oldestRunId);
            evictedCanonicalRunIds.add(oldestRunId);
        }
        const sourceSnapshot = this.#snapshotFromRuns(nextSourceRuns, true);
        const requestBoundaries = this.#requestBoundaries.merge(
            sourceStorageKey,
            canonicalStorageKey
        );
        const canonicalSnapshot = this.#snapshotFromRuns(
            nextCanonicalRuns,
            true,
            requestBoundaries
        );
        if (
            !this.#persistSessionPromotion(
                sourceStorageKey,
                canonicalStorageKey,
                sourceSnapshot,
                canonicalSnapshot
            )
        ) {
            return false;
        }
        if (nextCanonicalRuns.size === 0) {
            this.#runsBySession.delete(canonicalStorageKey);
        } else {
            this.#runsBySession.set(canonicalStorageKey, nextCanonicalRuns);
        }
        this.#pendingPersistence.delete(canonicalStorageKey);

        if (nextSourceRuns.size === 0) {
            this.#runsBySession.delete(sourceStorageKey);
        } else {
            this.#runsBySession.set(sourceStorageKey, nextSourceRuns);
        }
        this.#pendingPersistence.delete(sourceStorageKey);
        this.#requestBoundaries.forget(sourceStorageKey);
        this.#requestBoundaries.forget(canonicalStorageKey);
        this.#requestBoundaries.restore(canonicalStorageKey, requestBoundaries);
        for (const runId of movedRunIds) {
            this.#forgetRunSession(runId, sourceStorageKey);
            if (nextCanonicalRuns.has(runId)) {
                this.#rememberRunSession(runId, canonicalStorageKey);
            }
        }
        if (repairedRunIdentity) {
            this.#forgetRunSession(
                repairedRunIdentity.provisionalRunId,
                canonicalStorageKey
            );
            this.#rememberRunSession(
                repairedRunIdentity.providerRunId,
                canonicalStorageKey
            );
        }
        for (const runId of evictedCanonicalRunIds) {
            this.#forgetRunSession(runId, canonicalStorageKey);
        }
        this.#enforceSessionLimit(protectedSessionKey);
        this.#enforceReplayMemoryLimit(protectedSessionKey || canonicalStorageKey);
        return true;
    }

    #refreshTotalReplayBytes(): void {
        let totalBytes = 0;
        for (const runs of this.#runsBySession.values()) {
            totalBytes += replayBytes(runs.values());
        }
        this.#totalReplayBytes = totalBytes;
    }

    #enforceReplayMemoryLimit(protectedSessionKey?: string): void {
        if (this.#enforcingReplayMemoryLimit || this.#replayMemoryLimitDeferrals > 0) {
            return;
        }
        const storageProtectedSessionKey = protectedSessionKey
            ? normalizedSessionKey(protectedSessionKey)
            : undefined;
        this.#enforcingReplayMemoryLimit = true;
        try {
            this.#refreshTotalReplayBytes();
            while (this.#totalReplayBytes > this.#maxReplayBytes) {
                const oldestSessionKey =
                    oldestReplayBudgetSessionKey(
                        this.#runsBySession,
                        storageProtectedSessionKey
                    ) ?? oldestReplayBudgetSessionKey(this.#runsBySession);
                if (!oldestSessionKey) {
                    break;
                }
                // Keep the freshest persisted copy before releasing process memory.
                // The hard memory ceiling still wins if SQLite is temporarily failing.
                this.#flushSessionPersistence(oldestSessionKey);
                this.#evictSessionFromMemory(oldestSessionKey);
            }
        } finally {
            this.#enforcingReplayMemoryLimit = false;
        }
    }

    #enforceSessionLimit(protectedSessionKey?: string): void {
        if (this.#sessionLimitDeferrals > 0) {
            return;
        }
        const storageProtectedSessionKey = protectedSessionKey
            ? normalizedSessionKey(protectedSessionKey)
            : undefined;
        while (this.#runsBySession.size > MAX_CHAT_RUNTIME_SESSIONS) {
            const oldestSessionKey = oldestEvictableSessionKey(
                this.#runsBySession,
                storageProtectedSessionKey
            );
            if (!oldestSessionKey) {
                break;
            }
            this.#evictSessionFromMemory(oldestSessionKey);
            this.#deletePersistedSession(oldestSessionKey);
        }
    }

    #sessionCandidates(
        providedSessionKey: string,
        runId: string | undefined,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): Map<string, string> {
        const indexedCandidates = matchingSessionKeys(providedSessionKey, sessions);
        const associatedCandidates = new Map<string, string>();
        if (runId) {
            const normalizedProvidedKey = normalizedSessionKey(providedSessionKey);
            const associatedSessionKeys = this.#sessionsByRun.get(runId) || [];
            for (const associatedSessionKey of associatedSessionKeys) {
                if (
                    normalizedSessionKey(associatedSessionKey) !==
                        normalizedProvidedKey &&
                    isSameSessionKey(associatedSessionKey, providedSessionKey)
                ) {
                    associatedCandidates.set(
                        normalizedSessionKey(associatedSessionKey),
                        associatedSessionKey
                    );
                }
            }
        }
        if (indexedCandidates.size > 1 && associatedCandidates.size > 0) {
            const indexedAssociations = new Map<string, string>();
            for (const [normalizedKey, candidate] of associatedCandidates) {
                if (indexedCandidates.has(normalizedKey)) {
                    indexedAssociations.set(normalizedKey, candidate);
                }
            }
            if (indexedAssociations.size > 0) {
                return indexedAssociations;
            }
        }
        return new Map([...indexedCandidates, ...associatedCandidates]);
    }

    #enrichPayload(
        event: unknown,
        payload: unknown,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): unknown {
        if (typeof event !== "string" || !RETAINED_EVENTS.has(event)) {
            return payload;
        }

        const record = asRecord(payload);
        if (!record) {
            return payload;
        }

        const payloadView = runtimePayloadView(record) || record;

        this.reconcileSessions(sessions);

        const runId =
            stringField(payloadView, "runId") ||
            this.#retainedSessionMessageRunId(event, payloadView);
        const providedSessionKey = stringField(payloadView, "sessionKey");
        if (providedSessionKey) {
            const candidates = this.#sessionCandidates(
                providedSessionKey,
                runId,
                sessions
            );
            if (candidates.size === 1) {
                const canonical = candidates.values().next().value;
                return withRuntimeIdentity(record, {
                    runId,
                    sessionKey: canonical || providedSessionKey,
                });
            }
            if (candidates.size > 1 && !isAgentSessionKey(providedSessionKey)) {
                return withRuntimeIdentity(record, {
                    runId,
                    shouldRemoveSessionKey: true,
                });
            }
            return withRuntimeIdentity(record, {
                runId,
                sessionKey: providedSessionKey,
            });
        }

        if (!runId) {
            return payload;
        }

        const candidateSessionKeys = new Set(this.#sessionsByRun.get(runId));
        for (const session of sessions) {
            if (hasRunIdentifier(session, runId)) {
                candidateSessionKeys.add(session.key);
            }
        }
        const sessionKey =
            candidateSessionKeys.size === 1
                ? candidateSessionKeys.values().next().value
                : undefined;

        return withRuntimeIdentity(record, { runId, sessionKey });
    }

    #retainedSessionMessageRunId(
        event: unknown,
        payload: Record<string, unknown>
    ): string | undefined {
        const inferredRunId = sessionMessageRunId(event, payload);
        if (inferredRunId && !isProvisionalRunId(inferredRunId)) {
            return inferredRunId;
        }
        const sessionKey = stringField(payload, "sessionKey");
        const provisionalActiveRunIds = sessionMessageActiveRunIds(payload).filter(
            (runId) => isProvisionalRunId(runId)
        );
        if (!sessionKey || provisionalActiveRunIds.length !== 1) {
            return inferredRunId;
        }
        const activeRunId = provisionalActiveRunIds[0]!;
        for (const [candidateSessionKey, runs] of this.#runsBySession) {
            const run = runs.get(activeRunId);
            if (
                run &&
                !run.completed &&
                isSameSessionKey(candidateSessionKey, sessionKey)
            ) {
                return activeRunId;
            }
        }
        return inferredRunId;
    }

    #rememberRunSession(runId: string, sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = new Set(this.#sessionsByRun.get(runId));
        sessionKeys.add(storageSessionKey);
        this.#sessionsByRun.delete(runId);
        this.#sessionsByRun.set(runId, sessionKeys);

        while (this.#sessionsByRun.size > MAX_RUN_ASSOCIATIONS) {
            const oldestRunId = this.#sessionsByRun.keys().next().value;
            if (!oldestRunId) {
                break;
            }
            this.#sessionsByRun.delete(oldestRunId);
        }
    }

    #forgetRunSession(runId: string, sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = this.#sessionsByRun.get(runId);
        if (!sessionKeys) {
            return;
        }
        sessionKeys.delete(storageSessionKey);
        if (sessionKeys.size === 0) {
            this.#sessionsByRun.delete(runId);
        }
    }

    #replaceRunEvents(run: RetainedRun, events: OpenClawRuntimeEnvelope[]): void {
        const uniqueEvents = new Map<number, OpenClawRuntimeEnvelope>();
        for (const event of events) {
            uniqueEvents.set(event.runtimeSequence, event);
        }
        run.events = uniqueEvents
            .values()
            .toArray()
            .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence);
        run.eventBytes = run.events.map((event) =>
            Buffer.byteLength(JSON.stringify(event))
        );
        run.totalBytes = run.eventBytes.reduce((total, bytes) => total + bytes, 0);
        trimRetainedRun(run);
    }

    #rewriteProvisionalPayloads(
        sessionKey: string,
        run: RetainedRun,
        provisionalRunId: string,
        providerRunId: string
    ): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const events = run.events.flatMap((envelope) => {
            const payload = asRecord(envelope.payload);
            const payloadRunId = stringField(runtimePayloadView(payload), "runId");
            if (
                !payload ||
                (payloadRunId &&
                    payloadRunId !== provisionalRunId &&
                    !isProvisionalRunId(payloadRunId))
            ) {
                return [envelope];
            }

            const rewritten = {
                ...envelope,
                payload: withRuntimeIdentity(payload, { runId: providerRunId }),
            };
            if (Buffer.byteLength(JSON.stringify(rewritten)) <= MAX_BYTES_PER_EVENT) {
                return [rewritten];
            }
            if (!isTerminalEvent(envelope.event, rewritten.payload)) {
                return [];
            }
            const compact = {
                ...envelope,
                payload: compactTerminalPayload(
                    asRecord(rewritten.payload),
                    providerRunId,
                    storageSessionKey
                ),
            };
            return Buffer.byteLength(JSON.stringify(compact)) <= MAX_BYTES_PER_EVENT
                ? [compact]
                : [];
        });
        this.#replaceRunEvents(run, events);
    }

    #mergeRunEntry(
        sessionKey: string,
        runs: Map<string, RetainedRun>,
        provisionalRunId: string,
        providerRunId: string
    ): RetainedRun | undefined {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const provisional = runs.get(provisionalRunId);
        if (!provisional || provisionalRunId === providerRunId) {
            return provisional;
        }

        this.#rewriteProvisionalPayloads(
            storageSessionKey,
            provisional,
            provisionalRunId,
            providerRunId
        );
        runs.delete(provisionalRunId);
        const existing = runs.get(providerRunId);
        if (existing) {
            this.#replaceRunEvents(existing, [...provisional.events, ...existing.events]);
            existing.completed ||= provisional.completed;
            existing.interruptionEligible ||= provisional.interruptionEligible;
            existing.interruptedAt = latestOptionalTimestamp(
                existing.interruptedAt,
                provisional.interruptedAt
            );
            existing.terminalSequence = Math.max(
                existing.terminalSequence,
                provisional.terminalSequence
            );
            existing.updatedAt = Math.max(existing.updatedAt, provisional.updatedAt);
            return existing;
        }

        provisional.runId = providerRunId;
        runs.set(providerRunId, provisional);
        return provisional;
    }

    #promoteRunEntry(
        sessionKey: string,
        runs: Map<string, RetainedRun>,
        provisionalRunId: string,
        providerRunId: string
    ): RetainedRun | undefined {
        const shouldForgetAssociation =
            provisionalRunId !== providerRunId && runs.has(provisionalRunId);
        const promotedRun = this.#mergeRunEntry(
            sessionKey,
            runs,
            provisionalRunId,
            providerRunId
        );
        if (shouldForgetAssociation && promotedRun) {
            this.#forgetRunSession(provisionalRunId, sessionKey);
        }
        return promotedRun;
    }

    #repairInterruptedRunSplit(
        sessionKey: string,
        runs: Map<string, RetainedRun>
    ): RepairedInterruptedRun | undefined {
        const candidates: Array<{
            providerRunId: string;
            provisionalRunId: string;
        }> = [];
        const requestBoundary = this.#requestBoundaries.latest(sessionKey);
        for (const providerRun of runs.values()) {
            if (isProvisionalRunId(providerRun.runId)) {
                continue;
            }
            const startingEnvelope = providerRun.events.findLast((envelope) => {
                const envelopeRunId = stringField(
                    runtimePayloadView(envelope.payload),
                    "runId"
                );
                return (
                    envelopeRunId === providerRun.runId &&
                    isStartingLifecycleEvent(envelope.event, envelope.payload)
                );
            });
            if (!startingEnvelope) {
                continue;
            }
            for (const provisionalRun of runs.values()) {
                if (
                    provisionalRun !== providerRun &&
                    (providerRun.interruptionEligible ||
                        provisionalRun.interruptedAt !== undefined) &&
                    isPromotableInterruptedDashboardRun(
                        provisionalRun,
                        startingEnvelope,
                        runs,
                        requestBoundary,
                        providerRun
                    )
                ) {
                    candidates.push({
                        providerRunId: providerRun.runId,
                        provisionalRunId: provisionalRun.runId,
                    });
                }
            }
        }
        if (candidates.length !== 1) {
            return undefined;
        }
        const candidate = candidates[0]!;
        const repairedRun = this.#mergeRunEntry(
            sessionKey,
            runs,
            candidate.provisionalRunId,
            candidate.providerRunId
        );
        return repairedRun
            ? {
                  providerRunId: repairedRun.runId,
                  provisionalRunId: candidate.provisionalRunId,
              }
            : undefined;
    }

    #promoteProvisionalRun(
        sessionKey: string,
        providerRunId: string,
        preferredProvisionalRunId?: string,
        requestBoundary?: number
    ): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        let runs = this.#runsBySession.get(storageSessionKey);
        if (
            preferredProvisionalRunId &&
            !runs?.has(preferredProvisionalRunId) &&
            isAgentSessionKey(storageSessionKey)
        ) {
            const aliasEntries = [...this.#runsBySession].filter(
                ([candidateSessionKey, candidateRuns]) =>
                    !isAgentSessionKey(candidateSessionKey) &&
                    isSameSessionKey(candidateSessionKey, storageSessionKey) &&
                    candidateRuns.has(preferredProvisionalRunId)
            );
            if (aliasEntries.length === 1) {
                this.#promoteSessionEntry(
                    aliasEntries[0]![0],
                    storageSessionKey,
                    preferredProvisionalRunId
                );
                runs = this.#runsBySession.get(storageSessionKey);
            }
        }
        if (!runs) {
            return;
        }

        const preferred = preferredProvisionalRunId
            ? runs.get(preferredProvisionalRunId)
            : undefined;
        if (preferredProvisionalRunId && preferred) {
            this.#promoteRunEntry(
                storageSessionKey,
                runs,
                preferredProvisionalRunId,
                providerRunId
            );
            this.#enforceReplayMemoryLimit(storageSessionKey);
            this.#flushSessionPersistence(storageSessionKey);
            return;
        }

        const provisionalEntries = runs
            .entries()
            .filter(([runId, run]) => {
                const isCurrentRequest =
                    requestBoundary === undefined || firstSequence(run) > requestBoundary;
                return (
                    runId !== providerRunId &&
                    isProvisionalRunId(run.runId) &&
                    isCurrentRequest &&
                    (!run.completed || isRunlessRunId(run.runId))
                );
            })
            .toArray();
        if (provisionalEntries.length !== 1) {
            return;
        }

        this.#promoteRunEntry(
            storageSessionKey,
            runs,
            provisionalEntries[0]![0],
            providerRunId
        );
        this.#enforceReplayMemoryLimit(storageSessionKey);
        this.#flushSessionPersistence(storageSessionKey);
    }

    #retain(envelope: OpenClawRuntimeEnvelope, shouldPersist = true): void {
        if (typeof envelope.event !== "string" || !RETAINED_EVENTS.has(envelope.event)) {
            return;
        }

        const payload = asRecord(envelope.payload);
        const payloadView = runtimePayloadView(payload);
        if (!payload || !payloadView) {
            return;
        }
        const sessionKey = stringField(payloadView, "sessionKey");
        if (!sessionKey) {
            return;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);

        const explicitRunId = stringField(payloadView, "runId");
        const isTerminal = isTerminalEvent(envelope.event, envelope.payload);
        const associationBytes = explicitRunId
            ? Buffer.byteLength(
                  JSON.stringify({ runId: explicitRunId, sessionKey: storageSessionKey })
              )
            : 0;
        if (explicitRunId && associationBytes <= MAX_BYTES_PER_EVENT) {
            this.#rememberRunSession(explicitRunId, storageSessionKey);
        }
        if (!shouldRetainRuntimeEvent(envelope.event, payloadView)) {
            return;
        }
        const serializedBytes = Buffer.byteLength(JSON.stringify(envelope));
        const retainedEnvelope =
            serializedBytes <= MAX_BYTES_PER_EVENT
                ? envelope
                : isTerminal
                  ? {
                        ...envelope,
                        payload: compactTerminalPayload(
                            payload,
                            explicitRunId,
                            storageSessionKey
                        ),
                    }
                  : undefined;
        if (!retainedEnvelope) {
            return;
        }

        const retainedBytes =
            retainedEnvelope === envelope
                ? serializedBytes
                : Buffer.byteLength(JSON.stringify(retainedEnvelope));
        if (retainedBytes > MAX_BYTES_PER_EVENT) {
            return;
        }

        if (shouldPersist) {
            this.#pruneStaleActiveRuns(storageSessionKey);
        }
        const runs =
            this.#runsBySession.get(storageSessionKey) || new Map<string, RetainedRun>();
        if (explicitRunId && !runs.has(explicitRunId)) {
            const pendingUserRuns = runs
                .values()
                .filter(
                    (run) =>
                        isPromotableRunlessUserLedRun(run, retainedEnvelope, runs) ||
                        isPromotableInterruptedDashboardRun(
                            run,
                            retainedEnvelope,
                            runs,
                            this.#requestBoundaries.latest(storageSessionKey)
                        )
                )
                .toArray();
            if (pendingUserRuns.length === 1) {
                const promotedRun = this.#promoteRunEntry(
                    storageSessionKey,
                    runs,
                    pendingUserRuns[0]!.runId,
                    explicitRunId
                );
                if (promotedRun && !shouldPersist) {
                    this.#queuePersistence(storageSessionKey);
                }
            }
        }
        const activeRuns = runs
            .values()
            .filter((snapshot) => !snapshot.completed)
            .toArray();
        const isCompaction = isCompactionEvent(envelope.event, envelope.payload);
        const activeConversationRuns = activeRuns.filter(
            (run) => !isCompactionOnlyRun(run)
        );
        const canSettleOnlyCompaction =
            activeConversationRuns.length === 0 &&
            isSettlingLifecycleEvent(envelope.event, envelope.payload);
        const compatibleActiveRuns =
            isCompaction || canSettleOnlyCompaction ? activeRuns : activeConversationRuns;
        const activeRunlessRuns = compatibleActiveRuns.filter((run) =>
            isRunlessRunId(run.runId)
        );
        const compatibleActiveRun =
            compatibleActiveRuns.length === 1
                ? compatibleActiveRuns[0]
                : activeRunlessRuns.length === 1
                  ? activeRunlessRuns[0]
                  : undefined;
        const isMetadataOnlyCompletion =
            !explicitRunId && isMetadataOnlyCompletionEnvelope(retainedEnvelope);
        const completedRuns =
            isCompaction ||
            (!explicitRunId &&
                (isMetadataOnlyCompletion || envelope.event === "session.message"))
                ? runs
                      .values()
                      .filter((run) => run.completed)
                      .toArray()
                      .toSorted(
                          (left, right) => right.terminalSequence - left.terminalSequence
                      )
                : [];
        const latestMeaningfulCompletion = completedRuns.find(
            (run) => !isAuxiliaryOnlyCompletion(run)
        );
        const hasNewerActiveRunlessWork = Boolean(
            compatibleActiveRun &&
            isRunlessRunId(compatibleActiveRun.runId) &&
            lastSequence(compatibleActiveRun) >
                (latestMeaningfulCompletion?.terminalSequence ?? -1)
        );
        if (
            isMetadataOnlyCompletion &&
            latestMeaningfulCompletion &&
            !hasNewerActiveRunlessWork
        ) {
            return;
        }
        const metadataCompletionRun = isMetadataOnlyCompletion
            ? completedRuns.find((run) => isMetadataOnlyRunlessCompletion(run))
            : undefined;
        const completedEchoRun =
            !explicitRunId &&
            latestMeaningfulCompletion &&
            envelope.event === "session.message" &&
            hasChatFinal(latestMeaningfulCompletion) &&
            isMatchingSessionEcho(latestMeaningfulCompletion, envelope)
                ? latestMeaningfulCompletion
                : undefined;
        const retainedExplicitRunId =
            explicitRunId && (!isCompaction || runs.has(explicitRunId))
                ? explicitRunId
                : undefined;
        const runId =
            retainedExplicitRunId ||
            completedEchoRun?.runId ||
            compatibleActiveRun?.runId ||
            (isCompaction ? latestMeaningfulCompletion?.runId : undefined) ||
            explicitRunId ||
            metadataCompletionRun?.runId ||
            `runless:${envelope.runtimeSequence}`;
        let snapshot = runs.get(runId);

        if (!snapshot) {
            snapshot = {
                completed: false,
                eventBytes: [],
                events: [],
                interruptionEligible: !shouldPersist,
                runId,
                terminalSequence: -1,
                totalBytes: 0,
                updatedAt: retainedEnvelope.runtimeRecordedAt,
            };
            runs.set(runId, snapshot);
        }

        if (!isCompaction && snapshot.completed && isCompactionOnlyRun(snapshot)) {
            snapshot.completed = false;
            snapshot.terminalSequence = -1;
        }

        const coalescingKey = replayCoalescingKey(retainedEnvelope);
        const coalescingIndex = coalescingKey
            ? snapshot.events.findLastIndex(
                  (candidate) => replayCoalescingKey(candidate) === coalescingKey
              )
            : -1;
        if (coalescingIndex === -1) {
            snapshot.events.push(retainedEnvelope);
            snapshot.eventBytes.push(retainedBytes);
            snapshot.totalBytes += retainedBytes;
        } else {
            const coalescedEnvelope = coalesceReplayEnvelope(
                snapshot.events[coalescingIndex]!,
                retainedEnvelope
            );
            const coalescedBytes = Buffer.byteLength(JSON.stringify(coalescedEnvelope));
            const replayEnvelope =
                coalescedBytes <= MAX_BYTES_PER_EVENT
                    ? coalescedEnvelope
                    : retainedEnvelope;
            const replayBytes =
                replayEnvelope === coalescedEnvelope ? coalescedBytes : retainedBytes;
            snapshot.events.splice(coalescingIndex, 1);
            snapshot.totalBytes -= snapshot.eventBytes.splice(coalescingIndex, 1)[0] || 0;
            snapshot.events.push(replayEnvelope);
            snapshot.eventBytes.push(replayBytes);
            snapshot.totalBytes += replayBytes;
        }
        trimRetainedRun(snapshot);
        const completesRun =
            isTerminal &&
            (!isCompaction || snapshot.completed || isCompactionOnlyRun(snapshot));
        if (completesRun) {
            snapshot.terminalSequence = envelope.runtimeSequence;
        }
        snapshot.completed ||= completesRun;
        if (snapshot.completed) {
            // Completed tool calls are durable in chat.history. Keep the runtime-only
            // thinking/control stream while bounding the long-term SQLite footprint.
            compactCompletedRun(snapshot);
        }
        snapshot.updatedAt = Math.max(
            snapshot.updatedAt,
            retainedEnvelope.runtimeRecordedAt
        );

        while (runs.size > MAX_RUNS_PER_SESSION) {
            const oldestRunId = runs
                .values()
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
            if (!oldestRunId) {
                break;
            }
            runs.delete(oldestRunId);
            this.#forgetRunSession(oldestRunId, storageSessionKey);
        }

        this.#runsBySession.set(storageSessionKey, runs);
        this.#enforceSessionLimit();
        this.#enforceReplayMemoryLimit(storageSessionKey);
        if (shouldPersist && this.#runsBySession.has(storageSessionKey)) {
            if (isTerminal) {
                this.#flushSessionPersistence(storageSessionKey);
            } else {
                this.#queuePersistence(storageSessionKey);
            }
        }
    }

    #dropMemoryState(): void {
        this.#runsBySession.clear();
        this.#sessionsByRun.clear();
        this.#hydratedSessionLookups.clear();
        this.#requestBoundaries.clear();
        this.#loadedStoreKeys.clear();
        this.#totalReplayBytes = 0;
    }

    #settleRequestBoundary(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary: number | undefined,
        isContinuation: boolean
    ): void {
        const changedSessionKeys = this.#requestBoundaries.settle(
            sessionKey,
            requestId,
            fallbackBoundary,
            isContinuation
        );
        for (const candidateSessionKey of changedSessionKeys) {
            if (this.#runsBySession.has(candidateSessionKey)) {
                this.#flushSessionPersistence(candidateSessionKey);
            }
        }
    }

    #requestContinuesExistingRun(
        sessionKey: string,
        runId: string | undefined,
        requestBoundary?: number
    ): boolean {
        if (requestBoundary === undefined) {
            return false;
        }
        const activeCandidates: RetainedRun[] = [];
        for (const [candidateSessionKey, runs] of this.#runsBySession) {
            if (!isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            if (runId) {
                const run = runs.get(runId);
                if (run) {
                    return firstSequence(run) <= requestBoundary;
                }
                continue;
            }
            activeCandidates.push(
                ...runs
                    .values()
                    .filter(
                        (run) =>
                            !run.completed &&
                            !isCompactionOnlyRun(run) &&
                            firstSequence(run) <= requestBoundary
                    )
            );
        }
        return !runId && activeCandidates.length === 1;
    }

    /** Flushes all coalesced replay writes at lifecycle boundaries. */
    flush(): boolean {
        this.#cancelPersistenceTimer();
        if (!this.#retryStoreClear()) {
            return false;
        }
        let didFlushAll = true;
        for (const pendingClear of this.#pendingSessionClears) {
            didFlushAll = this.#retryPendingSessionClear(pendingClear) && didFlushAll;
        }
        for (const pendingKey of this.#pendingDeleteKeys) {
            didFlushAll = this.#retryExactDelete(pendingKey) && didFlushAll;
        }
        didFlushAll = this.#flushPendingPersistence() && didFlushAll;
        return (
            didFlushAll &&
            !this.#storeClearPending &&
            this.#pendingSessionClears.size === 0 &&
            this.#pendingDeleteKeys.size === 0 &&
            this.#pendingPersistence.size === 0
        );
    }

    /** Drops only process-local indexes while retaining the persisted replay. */
    clearMemory(): boolean {
        if (!this.flush()) {
            return false;
        }
        this.#dropMemoryState();
        return true;
    }

    /** Restores persisted run associations before a Gateway scope resumes events. */
    hydratePersistedSessions(): void {
        const storedKeys = this.#storedSessionKeys();
        if (!storedKeys) {
            return;
        }
        this.#withDeferredSessionLimit(() => {
            for (const sessionKey of storedKeys) {
                this.#ensureSessionLoaded(sessionKey);
            }
        });
        this.#enforceSessionLimit();
        this.#enforceReplayMemoryLimit();
    }

    /** Allows one interrupted live Dashboard run to resume under a provider run ID. */
    markGatewayDisconnected(disconnectedAt = Date.now()): void {
        for (const [sessionKey, runs] of this.#runsBySession) {
            const interruptedRuns = runs
                .values()
                .filter(
                    (candidate) =>
                        !candidate.completed &&
                        candidate.runId.startsWith("dashboard-chat-")
                )
                .toArray();
            for (const run of interruptedRuns) {
                run.interruptionEligible = true;
                run.interruptedAt = disconnectedAt;
            }
            if (interruptedRuns.length > 0) {
                this.#queuePersistence(sessionKey);
            }
        }
    }

    /** Clears all replay state, for example after credentials change. */
    clear(): void {
        this.#cancelPersistenceTimer();
        this.#pendingPersistence.clear();
        this.#dropMemoryState();
        if (!this.#store) {
            return;
        }
        this.#storeClearPending = true;
        this.#retryStoreClear();
    }

    /** Canonicalizes quarantined short session keys after the session index loads. */
    reconcileSessions(sessions: readonly OpenClawChatSessionIdentity[]): void {
        for (const sessionKey of this.#runsBySession.keys()) {
            if (isAgentSessionKey(sessionKey)) {
                continue;
            }
            const runs = this.#runsBySession.get(sessionKey);
            if (!runs) {
                continue;
            }
            for (const runId of runs.keys()) {
                const candidates = this.#sessionCandidates(sessionKey, runId, sessions);
                if (candidates.size === 1) {
                    const canonical = candidates.values().next().value;
                    if (canonical && canonical !== sessionKey) {
                        this.#promoteSessionEntry(sessionKey, canonical, runId);
                    }
                }
            }
        }
    }

    /** Hydrates the target before durably capturing one outgoing chat request. */
    captureRequestBoundary(sessionKey?: string, requestId?: string): number {
        this.#requireSequenceHydrated();
        if (sessionKey) {
            if (!this.#ensureSessionLoaded(sessionKey)) {
                throw new Error("Chat send boundary session could not be hydrated");
            }
            const storageSessionKey = normalizedSessionKey(sessionKey);
            const exactRuns = this.#runsBySession.get(storageSessionKey);
            const aliasSessionKeys = this.#runsBySession
                .entries()
                .filter(
                    ([candidateSessionKey, runs]) =>
                        runs.size > 0 &&
                        isSameSessionKey(candidateSessionKey, storageSessionKey)
                )
                .map(([candidateSessionKey]) => candidateSessionKey)
                .toArray();
            const boundarySessionKey = exactRuns?.size
                ? storageSessionKey
                : aliasSessionKeys.length === 1
                  ? aliasSessionKeys[0]
                  : undefined;
            if (!boundarySessionKey && aliasSessionKeys.length > 1) {
                throw new Error("Chat send boundary session is ambiguous");
            }
            if (boundarySessionKey) {
                this.#requestBoundaries.capture(
                    boundarySessionKey,
                    requestId,
                    this.#sequence
                );
                if (!this.#flushSessionPersistence(boundarySessionKey)) {
                    throw new Error("Chat send boundary could not be persisted");
                }
            }
        }
        return this.#sequence;
    }

    /** Clears replay state associated with one reset, aborted, or deleted session. */
    clearSession(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = new Set([storageSessionKey]);
        for (const candidateSessionKey of this.#runsBySession.keys()) {
            if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                sessionKeys.add(candidateSessionKey);
            }
        }
        for (const candidateSessionKey of this.#pendingPersistence) {
            if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                sessionKeys.add(candidateSessionKey);
            }
        }
        this.#requestBoundaries.forget(storageSessionKey);
        if (this.#store) {
            this.#pendingSessionClears.add(storageSessionKey);
        }
        const storedSessionKeys = this.#storedSessionKeys();
        if (storedSessionKeys) {
            for (const candidateSessionKey of storedSessionKeys) {
                if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                    sessionKeys.add(candidateSessionKey);
                }
            }
        }
        for (const matchingSessionKey of sessionKeys) {
            this.#evictSessionFromMemory(matchingSessionKey);
        }
        if (!this.#store) {
            return;
        }

        let didClearAll = storedSessionKeys !== undefined;
        for (const matchingSessionKey of sessionKeys) {
            if (!this.#deletePersistedSession(matchingSessionKey)) {
                didClearAll = false;
            }
        }
        if (didClearAll) {
            for (const pendingKey of this.#pendingDeleteKeys) {
                if (isSameSessionKey(pendingKey, storageSessionKey)) {
                    this.#pendingDeleteKeys.delete(pendingKey);
                }
            }
            for (const pendingClear of this.#pendingSessionClears) {
                if (isSameSessionKey(pendingClear, storageSessionKey)) {
                    this.#pendingSessionClears.delete(pendingClear);
                }
            }
        } else {
            this.#pendingSessionClears.add(storageSessionKey);
        }
    }

    /** Updates run associations and replay cleanup after successful RPCs. */
    handleSuccessfulRequest(
        method: string,
        parameters: Record<string, unknown>,
        payload: unknown,
        requestBoundary?: number
    ): void {
        if (method === "chat.abort") {
            const sessionKey = stringField(parameters, "sessionKey");
            if (sessionKey) {
                this.clearSession(sessionKey);
            }
            return;
        }
        if (method === "sessions.delete") {
            const sessionKey = stringField(parameters, "key");
            if (sessionKey) {
                this.clearSession(sessionKey);
            }
            return;
        }
        if (method !== "chat.send") {
            return;
        }

        const sessionKey = stringField(parameters, "sessionKey");
        const message = stringField(parameters, "message");
        if (sessionKey && message && /^\/(?:new|reset)(?:\s|$)/i.test(message)) {
            this.clearSession(sessionKey);
            return;
        }
        const runId = stringField(asRecord(payload), "runId");
        const provisionalRunId = stringField(parameters, "idempotencyKey");
        if (sessionKey) {
            this.#ensureSessionLoaded(sessionKey);
            const continuesExistingRun = this.#requestContinuesExistingRun(
                sessionKey,
                runId,
                requestBoundary
            );
            const acknowledgedRunId =
                runId || (continuesExistingRun ? undefined : provisionalRunId);
            if (acknowledgedRunId) {
                this.#promoteProvisionalRun(
                    sessionKey,
                    acknowledgedRunId,
                    provisionalRunId,
                    requestBoundary
                );
            }
            this.#settleRequestBoundary(
                sessionKey,
                provisionalRunId,
                requestBoundary,
                continuesExistingRun
            );
            this.#clearCompletedRuns(sessionKey, acknowledgedRunId);
            if (acknowledgedRunId) {
                this.#rememberRunSession(acknowledgedRunId, sessionKey);
            }
        }
    }

    /**
     * Records one Gateway event and returns the exact sequenced envelope to
     * broadcast. Events without a session remain live-only and are not cached.
     */
    recordEvent(
        event: unknown,
        payload: unknown,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): OpenClawRuntimeEnvelope {
        this.#requireSequenceHydrated();
        const providedSessionKey = stringField(runtimePayloadView(payload), "sessionKey");
        if (providedSessionKey) {
            this.#ensureSessionLoaded(providedSessionKey);
        }
        const enrichedPayload = this.#enrichPayload(event, payload, sessions);
        const enrichedSessionKey = stringField(asRecord(enrichedPayload), "sessionKey");
        if (enrichedSessionKey && enrichedSessionKey !== providedSessionKey) {
            this.#ensureSessionLoaded(enrichedSessionKey);
        }
        const envelope: OpenClawRuntimeEnvelope = {
            type: "event",
            event,
            payload: enrichedPayload,
            runtimeRecordedAt: Date.now(),
            runtimeSequence: ++this.#sequence,
        };
        const requestId = sessionMessageRequestId(event, enrichedPayload);
        if (enrichedSessionKey && requestId) {
            const requestBoundary = this.#requestBoundaries.pending(
                enrichedSessionKey,
                requestId
            );
            if (requestBoundary !== undefined) {
                const runId = stringField(runtimePayloadView(enrichedPayload), "runId");
                const isContinuation = this.#requestContinuesExistingRun(
                    enrichedSessionKey,
                    runId,
                    requestBoundary
                );
                this.#settleRequestBoundary(
                    enrichedSessionKey,
                    requestId,
                    requestBoundary,
                    isContinuation
                );
            }
        }
        this.#retain(envelope);
        return envelope;
    }

    /** Returns active runs or the latest completed run for one session. */
    snapshot(sessionKey: string): OpenClawRuntimeSnapshot {
        this.#replayMemoryLimitDeferrals += 1;
        try {
            this.#ensureSessionLoaded(sessionKey);
            if (this.#pruneStaleActiveRuns(sessionKey)) {
                this.#flushSessionPersistence(sessionKey);
            }
            return this.#snapshotFromMemory(sessionKey);
        } finally {
            this.#replayMemoryLimitDeferrals -= 1;
            this.#enforceReplayMemoryLimit(sessionKey);
        }
    }
}
