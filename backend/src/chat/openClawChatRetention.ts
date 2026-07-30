import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "../../../contracts/chat.ts";
import { withCanonicalOpenClawEvents } from "../../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    isAuxiliaryOnlyCompletion,
    isCompactionOnlyRun,
    isTerminalEvent,
} from "./openClawChatLifecycle.ts";
import {
    asRecord,
    compactCanonicalProviderPayload,
    envelopeBytes,
    nestedRuntimeItem,
    runtimePayloadView,
    stringField,
} from "./openClawChatProviderAdapter.ts";

export interface RetainedRun {
    completed: boolean;
    eventBytes: number[];
    events: OpenClawRuntimeEnvelope[];
    firstSequence: number;
    interruptionEligible: boolean;
    interruptedAt?: number;
    runId: string;
    terminalSequence: number;
    totalBytes: number;
    updatedAt: number;
}

export const MAX_EVENTS_PER_ACTIVE_RUN = 20_000;
export const MAX_BYTES_PER_ACTIVE_RUN = 64_000_000;
export const MAX_BYTES_PER_EVENT = 1_000_000;
export const MAX_RUNS_PER_SESSION = 4;
export const MAX_BYTES_ACROSS_REPLAY = MAX_BYTES_PER_ACTIVE_RUN * MAX_RUNS_PER_SESSION;
export const ACTIVE_RUN_TTL_MS = 6 * 60 * 60_000;

export const RETAINED_RUNTIME_EVENTS = new Set([
    "agent",
    "chat",
    "model.completed",
    "session.ended",
    "session.compaction",
    "session.message",
    "session.started",
    "session.tool",
]);

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

export function shouldRetainRuntimeEvent(
    event: unknown,
    payload: Record<string, unknown>,
    canonicalEvents: OpenClawRuntimeEnvelope["canonicalEvents"]
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
        return false;
    }
    return (
        !["start", "end"].includes(phase) ||
        !/\b(?:analysis|reasoning|thinking)\b/u.test(kind) ||
        hasRuntimeItemText(data, item) ||
        canonicalEvents.some(
            (canonicalEvent) =>
                canonicalEvent.kind === "thinking" &&
                (canonicalEvent.message.text.trim() ||
                    canonicalEvent.message.thinking?.some((block) => block.text.trim()))
        )
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

export function replayCoalescingKey(
    envelope: OpenClawRuntimeEnvelope
): string | undefined {
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

export function coalesceReplayEnvelope(
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
    const canonical = withCanonicalOpenClawEvents({
        ...next,
        payload: {
            ...previousPayload,
            ...nextPayload,
            data: { ...previousData, ...nextData },
        },
    });
    const nextEventIds = new Set(canonical.canonicalEvents.map((event) => event.id));
    const nextToolKeysWithArguments = new Set(
        canonical.canonicalEvents.flatMap((event) =>
            event.kind === "tool" &&
            event.message.toolCalls?.some((toolCall) => toolCall.arguments !== undefined)
                ? [event.toolKey]
                : []
        )
    );
    const preservedToolCalls = new Map(
        previous.canonicalEvents.flatMap((event) =>
            event.kind === "tool" &&
            event.message.toolCalls?.some((toolCall) => toolCall.arguments !== undefined)
                ? [[event.toolKey, event] as const]
                : []
        )
    );
    return boundedCanonicalRuntimeEnvelope({
        ...canonical,
        canonicalEvents: [
            ...preservedToolCalls
                .values()
                .filter(
                    (event) =>
                        !nextEventIds.has(event.id) &&
                        !nextToolKeysWithArguments.has(event.toolKey)
                ),
            ...canonical.canonicalEvents,
        ],
    });
}

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

export function trimRetainedRun(run: RetainedRun): void {
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

export function compactCompletedRun(run: RetainedRun): void {
    const retainedEvents = run.events.filter(
        (event) => !isTranscriptBackedToolEnvelope(event)
    );
    if (retainedEvents.length === run.events.length) {
        return;
    }
    run.events = retainedEvents;
    run.eventBytes = retainedEvents.map((event) => envelopeBytes(event));
    run.totalBytes = run.eventBytes.reduce((total, bytes) => total + bytes, 0);
}

export function boundedCanonicalRuntimeEnvelope(
    envelope: OpenClawRuntimeEnvelope
): OpenClawRuntimeEnvelope {
    if (envelopeBytes(envelope) <= MAX_BYTES_PER_EVENT) {
        return envelope;
    }
    const compacted = {
        ...envelope,
        payload: compactCanonicalProviderPayload(envelope.payload),
    };
    if (envelopeBytes(compacted) <= MAX_BYTES_PER_EVENT) {
        return compacted;
    }
    if (!isTerminalEvent(envelope.event, envelope.payload)) {
        return envelope;
    }
    const terminalEvents = envelope.canonicalEvents.flatMap((event) =>
        event.kind === "finish"
            ? [
                  {
                      ...event,
                      error:
                          event.error && event.error.length <= 4096
                              ? event.error
                              : undefined,
                      message: undefined,
                  },
              ]
            : []
    );
    const terminalEnvelope = {
        ...compacted,
        canonicalEvents: terminalEvents,
    };
    return envelopeBytes(terminalEnvelope) <= MAX_BYTES_PER_EVENT
        ? terminalEnvelope
        : envelope;
}

export function lastSequence(run: RetainedRun): number {
    return run.events.at(-1)?.runtimeSequence ?? -1;
}

export function firstSequence(run: RetainedRun): number {
    return run.firstSequence;
}

export function latestRunUpdatedAt(runs: Iterable<RetainedRun>): number {
    let latest = -Infinity;
    for (const run of runs) {
        latest = Math.max(latest, run.updatedAt);
    }
    return latest;
}

export function replayBytes(runs: Iterable<RetainedRun>): number {
    let bytes = 0;
    for (const run of runs) {
        bytes += run.totalBytes;
    }
    return bytes;
}

export function oldestReplayBudgetSessionKey(
    sessions: ReadonlyMap<string, ReadonlyMap<string, RetainedRun>>,
    isSameSessionKey: (left: string, right: string) => boolean,
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

export function oldestEvictableSessionKey(
    sessions: ReadonlyMap<string, ReadonlyMap<string, RetainedRun>>,
    isSameSessionKey: (left: string, right: string) => boolean,
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

/**
 * Selects the replay rows exposed to the browser or persisted to SQLite.
 * @param runs Retained runtime runs.
 * @param throughSequence Latest global runtime sequence.
 * @param shouldIncludePersistenceMetadata Whether to include restart metadata.
 * @param requestBoundaries Persisted outgoing-request boundaries.
 * @returns Bounded replay snapshot.
 */
export function snapshotFromRetainedRuns(
    runs: ReadonlyMap<string, RetainedRun> | undefined,
    throughSequence: number,
    shouldIncludePersistenceMetadata = false,
    requestBoundaries: Pick<
        OpenClawRuntimeSnapshot,
        "acknowledgedRequestIds" | "pendingRequestBoundaries" | "requestBoundary"
    > = {}
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
    const firstSequenceByRun = shouldIncludePersistenceMetadata
        ? Object.fromEntries(
              selected.map((snapshot) => [snapshot.runId, snapshot.firstSequence])
          )
        : {};

    return {
        completed: active.length === 0 && selected.length > 0,
        events: selected
            .flatMap((snapshot) => snapshot.events)
            .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence),
        ...(Object.keys(firstSequenceByRun).length > 0 && {
            firstSequenceByRun,
        }),
        ...(Object.keys(interruptedAtByRun).length > 0 && {
            interruptedAtByRun,
        }),
        ...(shouldIncludePersistenceMetadata && requestBoundaries),
        schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        throughSequence,
    };
}
