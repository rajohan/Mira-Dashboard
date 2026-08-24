import { addMilliseconds, getTime, toDate } from "date-fns";
import {
    and,
    asc,
    count,
    desc,
    eq,
    gt,
    inArray,
    isNotNull,
    lte,
    max,
    notInArray,
    or,
    sql,
} from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    chatRuntimeInputSchema,
    chatRuntimeOutputSchema,
    chatSendInputSchema,
    type ChatRuntimeInput,
    type ChatRuntimeOutput,
    type ChatSendInput,
} from "../../../contracts/chat.ts";
import {
    chatActiveRunsPerProcessMaximum,
    chatActiveRunsPerSessionMaximum,
    chatActiveRunStates,
    chatRunEventBytesMaximum,
    chatRunEventMaximum,
    chatRunEventPayloadMaximumBytes,
    chatRuntimeCatchUpMaximumEvents,
    chatRuntimeDurableResponseMaximumBytes,
    chatRuntimeEventSchema,
    chatRuntimeSnapshotSchema,
    type ChatRunState,
    type ChatRunSummary,
    type ChatRuntimeEvent,
    type ChatRuntimeSnapshot,
} from "../../../contracts/chatModel.ts";
import {
    chatHistoryRealtimeRoutingSchema,
    chatHistoryRealtimeTopic,
    chatRealtimeRoutingSchema,
    chatRealtimeTopic,
    chatRuntimeSnapshotRequiredPayloadSchema,
} from "../../../contracts/chatRealtime.ts";
import { realtimeEventRetentionMilliseconds } from "../../../contracts/realtime.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { compareStrings } from "../../../shared/validation.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { chatRunEvents } from "../../database/schema/chatRunEvents.ts";
import { chatRuns } from "../../database/schema/chatRuns.ts";
import { chatRuntimeSnapshots } from "../../database/schema/chatRuntimeSnapshots.ts";
import { chatTranscriptGenerations } from "../../database/schema/chatTranscriptGenerations.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import {
    chatRunEventInsertSchema,
    chatRunEventSelectSchema,
} from "../../database/validation/chatRunEvents.ts";
import {
    chatRunInsertSchema,
    chatRunSelectSchema,
    type ChatRunRow,
} from "../../database/validation/chatRuns.ts";
import {
    chatRuntimeSnapshotInsertSchema,
    chatRuntimeSnapshotSelectSchema,
} from "../../database/validation/chatRuntimeSnapshots.ts";
import {
    chatTranscriptGenerationInsertSchema,
    chatTranscriptGenerationSelectSchema,
    type ChatTranscriptGenerationRow,
} from "../../database/validation/chatTranscriptGenerations.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import {
    ChatAdmissionCapacityError,
    ChatAdmissionConflictError,
    ChatProviderSequenceConflictError,
    ChatProviderSequenceGapError,
    ChatRunBudgetExceededError,
    ChatRunNotFoundError,
    ChatRunTransitionError,
    ChatTranscriptUnavailableError,
} from "./errors.ts";
import {
    toChatRunSummary,
    toChatRuntimeEvent,
    toChatRuntimeSnapshot,
} from "./records.ts";
import { chatRunStateAfterEvent, reduceChatRuntimeSnapshot } from "./reducer.ts";
import type {
    ChatTranscriptGenerationChange,
    ChatTranscriptLifecycleEvent,
    ChatTranscriptLifecycleStore,
    ChatTranscriptSessionState,
} from "./transcriptLifecycle.ts";

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type ChatTransaction = Parameters<TransactionCallback>[0];

export const chatTerminalRetentionMilliseconds = 24 * 60 * 60 * 1000;
const chatRuntimeSnapshotMaximum = 12;
const chatActiveRunStateSet = new Set<string>(chatActiveRunStates);

type WithoutRuntimeBase<TEvent> = TEvent extends ChatRuntimeEvent
    ? Omit<TEvent, "runId" | "sequence">
    : never;
export type ChatRuntimeEventDraft = WithoutRuntimeBase<ChatRuntimeEvent>;

export interface ChatAdmissionActor {
    readonly id: string;
    readonly kind: "automation" | "user";
}

export interface ChatAdmissionResult {
    readonly admission: "created" | "replayed";
    readonly run: ChatRunSummary;
}

export interface ChatAppendResult {
    readonly insertedCount: number;
    readonly run: ChatRunSummary;
    readonly snapshot: ChatRuntimeSnapshot;
}

export interface ChatDispatchAdmission {
    readonly run: ChatRunSummary;
    readonly shouldDispatch: boolean;
}

export interface ChatCancellationAdmission {
    readonly run: ChatRunSummary;
    readonly shouldDispatch: boolean;
}

export interface ChatRecoveryCandidate {
    readonly dispatchAttempted: boolean;
    readonly request: ChatSendInput;
    readonly run: ChatRunSummary;
}

export interface ChatProviderRunWatermark {
    readonly lastProviderSequence: number;
    readonly providerRunId: string;
}

export interface ChatHistoryAlias {
    readonly historyMessageId: string;
    readonly idempotencyKey?: string;
    readonly providerRunId?: string;
    readonly sessionKey: string;
}

/** Payload- and identity-free durable chat aggregates for system observability. */
export interface ChatRepositoryMetrics {
    readonly activeRuns: number;
    readonly failedOrUnknownRuns: number;
    readonly retainedEventBytes: number;
    readonly retainedEvents: number;
    readonly retainedRuns: number;
    readonly retainedSnapshotBytes: number;
    readonly retainedSnapshots: number;
}

export interface ChatRepository extends ChatTranscriptLifecycleStore {
    acknowledgeDispatch(
        runId: string,
        providerRunId: string,
        at?: Date
    ): Promise<ChatRunSummary>;
    admit(
        input: ChatSendInput,
        actor: ChatAdmissionActor,
        at?: Date
    ): Promise<ChatAdmissionResult>;
    appendEvents(
        runId: string,
        events: readonly ChatRuntimeEventDraft[]
    ): Promise<ChatAppendResult>;
    beginDispatch(runId: string, at?: Date): Promise<ChatDispatchAdmission>;
    findByProviderRunId(
        sessionKey: string,
        providerRunId: string
    ): ChatRunSummary | undefined;
    findByProviderCorrelation(
        sessionKey: string,
        providerRunId: string
    ): ChatRunSummary | undefined;
    findRun(runId: string): ChatRunSummary | undefined;
    isRetiredProviderCorrelation(sessionKey: string, providerRunId: string): boolean;
    listRecoveryCandidates(): readonly ChatRecoveryCandidate[];
    listTranscriptRecoveryCandidates(
        sessionKey: string
    ): readonly ChatRecoveryCandidate[];
    listRecoverableRuns(): readonly ChatRunSummary[];
    listProviderRunWatermarks(sessionKey: string): readonly ChatProviderRunWatermark[];
    markOutcomeUnknown(runId: string, at?: Date): Promise<ChatRunSummary>;
    pruneExpired(at?: Date, limit?: number): Promise<number>;
    readMetrics(): ChatRepositoryMetrics;
    readRuntime(input: ChatRuntimeInput): ChatRuntimeOutput;
    readIntent(runId: string): ChatRecoveryCandidate | undefined;
    signalRuntimeChanged(at?: Date): Promise<void>;
    signalHistoryChanged(at?: Date): Promise<void>;
    settleUnresolved(runId: string, at?: Date): Promise<ChatRunSummary>;
    resolveLocalRunId(alias: ChatHistoryAlias): string | undefined;
    requestCancellation(
        runId: string,
        sessionKey: string,
        at?: Date
    ): Promise<ChatCancellationAdmission>;
}

function parseRun(row: unknown): ChatRunRow {
    return v.parse(chatRunSelectSchema, row);
}

function requiredCount(row: { value: number } | undefined): number {
    if (row === undefined || !Number.isSafeInteger(row.value) || row.value < 0) {
        throw new Error("Chat repository count is invalid");
    }
    return row.value;
}

function requiredCursor(row: { value: number | null } | undefined): number {
    const value = row?.value ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("Chat repository cursor is invalid");
    }
    return value;
}

function existingRun(
    transaction: ChatTransaction,
    runId: string
): ChatRunRow | undefined {
    const row = transaction.select().from(chatRuns).where(eq(chatRuns.id, runId)).get();
    return row === undefined ? undefined : parseRun(row);
}

function parseTranscriptGeneration(row: unknown): ChatTranscriptGenerationRow {
    return v.parse(chatTranscriptGenerationSelectSchema, row);
}

function existingTranscriptGeneration(
    transaction: ChatTransaction,
    gatewayScope: string,
    sessionKey: string
): ChatTranscriptGenerationRow | undefined {
    const row = transaction
        .select()
        .from(chatTranscriptGenerations)
        .where(
            and(
                eq(chatTranscriptGenerations.gatewayScope, gatewayScope),
                eq(chatTranscriptGenerations.sessionKey, sessionKey)
            )
        )
        .get();
    return row === undefined ? undefined : parseTranscriptGeneration(row);
}

function ensureTranscriptGeneration(
    transaction: ChatTransaction,
    gatewayScope: string,
    sessionKey: string,
    at: Date
): ChatTranscriptGenerationRow {
    const current = existingTranscriptGeneration(transaction, gatewayScope, sessionKey);
    if (current !== undefined) return current;
    const inserted = transaction
        .insert(chatTranscriptGenerations)
        .values(
            v.parse(chatTranscriptGenerationInsertSchema, {
                currentGeneration: 1,
                gatewayScope,
                lastBoundaryAction: null,
                lastBoundaryProviderUpdatedAt: null,
                observedAt: null,
                pendingAction: null,
                pendingControlId: null,
                pendingPreviousStatus: null,
                providerSessionId: null,
                providerUpdatedAt: null,
                sessionKey,
                status: "ready",
                updatedAt: at,
                version: 1,
            })
        )
        .returning()
        .get();
    if (inserted === undefined) {
        throw new Error("Chat transcript generation insert returned no row");
    }
    return parseTranscriptGeneration(inserted);
}

function currentTranscriptRun(
    transaction: ChatTransaction,
    gatewayScope: string,
    runId: string,
    requireReady = true
): ChatRunRow | undefined {
    const row = transaction
        .select({ run: chatRuns, transcript: chatTranscriptGenerations })
        .from(chatRuns)
        .innerJoin(
            chatTranscriptGenerations,
            and(
                eq(chatTranscriptGenerations.gatewayScope, chatRuns.gatewayScope),
                eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                eq(
                    chatTranscriptGenerations.currentGeneration,
                    chatRuns.transcriptGeneration
                )
            )
        )
        .where(
            and(
                eq(chatRuns.gatewayScope, gatewayScope),
                eq(chatRuns.id, runId),
                ...(requireReady
                    ? [eq(chatTranscriptGenerations.status, "ready" as const)]
                    : [])
            )
        )
        .get();
    return row === undefined ? undefined : parseRun(row.run);
}

function storedSnapshot(
    transaction: ChatTransaction,
    runId: string
): ChatRuntimeSnapshot | undefined {
    const row = transaction
        .select()
        .from(chatRuntimeSnapshots)
        .where(eq(chatRuntimeSnapshots.chatRunId, runId))
        .get();
    return row === undefined
        ? undefined
        : toChatRuntimeSnapshot(v.parse(chatRuntimeSnapshotSelectSchema, row));
}

function providerRange(
    event: ChatRuntimeEventDraft | ChatRuntimeEvent
): Readonly<{ end: number; start: number }> | undefined {
    if (event.kind === "assistant" || event.kind === "thinking") {
        return event.providerSequenceStart === undefined ||
            event.providerSequenceEnd === undefined
            ? undefined
            : { end: event.providerSequenceEnd, start: event.providerSequenceStart };
    }
    if (event.kind === "provider-noop") {
        return {
            end: event.providerSequenceEnd,
            start: event.providerSequenceStart,
        };
    }
    if ("providerSequence" in event && event.providerSequence !== undefined) {
        return { end: event.providerSequence, start: event.providerSequence };
    }
    return undefined;
}

function canonicalEventIdentity(value: unknown): string {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalEventIdentity(entry)).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .toSorted()
            .map((key) => `${JSON.stringify(key)}:${canonicalEventIdentity(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function providerIdentity(event: ChatRuntimeEventDraft | ChatRuntimeEvent): string {
    const candidate = event as ChatRuntimeEvent & {
        readonly occurredAtMs: number;
        readonly runId?: string;
        readonly sequence?: number;
    };
    const {
        occurredAtMs: _occurredAtMs,
        runId: _runId,
        sequence: _sequence,
        ...payload
    } = candidate;
    return canonicalEventIdentity(payload);
}

function isExactProviderReplay(
    transaction: ChatTransaction,
    runId: string,
    event: ChatRuntimeEventDraft
): boolean {
    const range = providerRange(event);
    if (range === undefined) return false;
    const overlaps = transaction
        .select()
        .from(chatRunEvents)
        .where(
            and(
                eq(chatRunEvents.chatRunId, runId),
                isNotNull(chatRunEvents.providerSequenceStart),
                isNotNull(chatRunEvents.providerSequenceEnd),
                lte(chatRunEvents.providerSequenceStart, range.end),
                // Both columns are known non-null under the predicates above.
                // Drizzle keeps the nullable type, while SQLite evaluates the comparison.
                or(
                    eq(chatRunEvents.providerSequenceEnd, range.start),
                    gt(chatRunEvents.providerSequenceEnd, range.start)
                )
            )
        )
        .all();
    if (overlaps.length === 0) return false;
    if (overlaps.length !== 1) throw new ChatProviderSequenceConflictError();
    const overlap = v.parse(chatRunEventSelectSchema, overlaps[0]);
    const stored = toChatRuntimeEvent(overlap);
    if (
        overlap.providerSequenceStart === range.start &&
        overlap.providerSequenceEnd === range.end &&
        providerIdentity(stored) === providerIdentity(event)
    ) {
        return true;
    }
    throw new ChatProviderSequenceConflictError();
}

function assertNextProviderRange(
    transaction: ChatTransaction,
    runId: string,
    event: ChatRuntimeEventDraft
): void {
    const range = providerRange(event);
    if (range === undefined) return;
    const previousEnd = requiredCursor(
        transaction
            .select({ value: max(chatRunEvents.providerSequenceEnd) })
            .from(chatRunEvents)
            .where(
                and(
                    eq(chatRunEvents.chatRunId, runId),
                    isNotNull(chatRunEvents.providerSequenceEnd)
                )
            )
            .get()
    );
    const expected = previousEnd + 1;
    if (range.start === expected) return;
    if (range.start > expected) {
        throw new ChatProviderSequenceGapError(expected, range.start);
    }
    throw new ChatProviderSequenceConflictError();
}

function stateUpdateForEvent(
    run: ChatRunRow,
    event: ChatRuntimeEvent,
    updatedAt: Date
): Partial<typeof chatRuns.$inferInsert> {
    const state = chatRunStateAfterEvent(run.state, event);
    const terminal =
        state === "cancelled" ||
        state === "completed" ||
        state === "failed" ||
        state === "unresolved";
    const runtimeAuthoritative = event.kind !== "user" && event.kind !== "reconciled";
    let reconciliationState = run.reconciliationState;
    if (event.kind === "reconciled") {
        reconciliationState = "history-authoritative";
    } else if (event.kind === "interrupted") {
        reconciliationState = "failed";
    } else if (runtimeAuthoritative) {
        reconciliationState = "runtime-authoritative";
    }
    const cancelledAt =
        event.kind === "cancel" || state === "cancelled"
            ? (run.cancelRequestedAt ?? updatedAt)
            : run.cancelRequestedAt;
    let failureCode: string | null = null;
    let failureMessage: string | null = null;
    if (state === "failed") {
        failureCode = run.failureCode;
        failureMessage = run.failureMessage;
        if (event.kind === "terminal") {
            failureCode = event.errorCode ?? "provider_error";
            failureMessage = event.errorMessage ?? "Chat provider reported an error";
        }
    }
    return {
        cancelRequestedAt: cancelledAt,
        failureCode,
        failureMessage,
        historyMessageId:
            event.kind === "reconciled"
                ? (event.historyMessageId ?? run.historyMessageId)
                : run.historyMessageId,
        providerRunId:
            event.kind === "terminal" && event.providerRunId !== undefined
                ? event.providerRunId
                : run.providerRunId,
        reconciledAt:
            event.kind === "reconciled" ? (run.reconciledAt ?? updatedAt) : null,
        reconciliationState,
        retentionExpiresAt: terminal
            ? (run.retentionExpiresAt ??
              addMilliseconds(updatedAt, chatTerminalRetentionMilliseconds))
            : null,
        state,
        stateVersion: run.stateVersion + 1,
        terminalAt: terminal ? (run.terminalAt ?? updatedAt) : null,
        updatedAt,
    };
}

function appendRealtimeMarker(transaction: ChatTransaction, at: Date): void {
    v.parse(chatRealtimeRoutingSchema, {
        entityType: "chat-runtime",
        operation: "snapshot-required",
        topic: chatRealtimeTopic,
    });
    transaction
        .insert(realtimeEvents)
        .values(
            v.parse(realtimeEventInsertSchema, {
                entityId: "current",
                entityType: "chat-runtime",
                expiresAt: addMilliseconds(at, realtimeEventRetentionMilliseconds),
                occurredAt: at,
                operation: "snapshot-required",
                payloadJson: JSON.stringify(
                    v.parse(chatRuntimeSnapshotRequiredPayloadSchema, {
                        kind: "snapshot-required",
                    })
                ),
                topic: chatRealtimeTopic,
            })
        )
        .run();
}

function appendHistoryRealtimeMarker(transaction: ChatTransaction, at: Date): void {
    v.parse(chatHistoryRealtimeRoutingSchema, {
        entityType: "chat-history",
        operation: "snapshot-required",
        topic: chatHistoryRealtimeTopic,
    });
    transaction
        .insert(realtimeEvents)
        .values(
            v.parse(realtimeEventInsertSchema, {
                entityId: "current",
                entityType: "chat-history",
                expiresAt: addMilliseconds(at, realtimeEventRetentionMilliseconds),
                occurredAt: at,
                operation: "snapshot-required",
                payloadJson: JSON.stringify(
                    v.parse(chatRuntimeSnapshotRequiredPayloadSchema, {
                        kind: "snapshot-required",
                    })
                ),
                topic: chatHistoryRealtimeTopic,
            })
        )
        .run();
}

function appendEventsInTransaction(
    transaction: ChatTransaction,
    initialRun: ChatRunRow,
    drafts: readonly ChatRuntimeEventDraft[]
): ChatAppendResult {
    let run = initialRun;
    let snapshot = storedSnapshot(transaction, run.id);
    const snapshotExists = snapshot !== undefined;
    let insertedCount = 0;
    for (const draft of drafts) {
        if (
            draft.kind === "reconciled" &&
            run.reconciliationState === "history-authoritative"
        ) {
            if ((draft.historyMessageId ?? null) === run.historyMessageId) continue;
            throw new ChatRunTransitionError(
                "A reconciled chat run cannot change authoritative history identity"
            );
        }
        if (isExactProviderReplay(transaction, run.id, draft)) continue;
        assertNextProviderRange(transaction, run.id, draft);
        const sequence = run.lastEventSequence + 1;
        if (sequence > chatRunEventMaximum) throw new ChatRunBudgetExceededError();
        const event = v.parse(chatRuntimeEventSchema, {
            ...draft,
            runId: run.id,
            sequence,
        });
        const payloadJson = JSON.stringify(event);
        const payloadBytes = utf8ByteLength(payloadJson);
        if (
            payloadBytes > chatRunEventPayloadMaximumBytes ||
            run.eventBytes + payloadBytes > chatRunEventBytesMaximum
        ) {
            throw new ChatRunBudgetExceededError();
        }
        const range = providerRange(event);
        transaction
            .insert(chatRunEvents)
            .values(
                v.parse(chatRunEventInsertSchema, {
                    chatRunId: run.id,
                    kind: event.kind,
                    occurredAt: toDate(event.occurredAtMs),
                    payloadBytes,
                    payloadJson,
                    providerSequenceEnd: range?.end ?? null,
                    providerSequenceStart: range?.start ?? null,
                    sequence,
                })
            )
            .run();
        const updatedAt = toDate(Math.max(getTime(run.updatedAt), event.occurredAtMs));
        const updated = transaction
            .update(chatRuns)
            .set({
                ...stateUpdateForEvent(run, event, updatedAt),
                eventBytes: run.eventBytes + payloadBytes,
                eventCount: sequence,
                lastEventSequence: sequence,
            })
            .where(
                and(eq(chatRuns.id, run.id), eq(chatRuns.stateVersion, run.stateVersion))
            )
            .returning()
            .get();
        if (updated === undefined) {
            throw new ChatRunTransitionError("Chat run changed during event append");
        }
        run = parseRun(updated);
        snapshot = reduceChatRuntimeSnapshot(snapshot, event, toChatRunSummary(run));
        insertedCount += 1;
    }
    if (snapshot === undefined) {
        throw new ChatRunTransitionError("Chat run has no durable admission snapshot");
    }
    if (insertedCount > 0) {
        const snapshotJson = JSON.stringify(snapshot);
        const stored = v.parse(chatRuntimeSnapshotInsertSchema, {
            chatRunId: run.id,
            firstSequence: snapshot.firstSequence,
            schemaVersion: 1,
            snapshotBytes: utf8ByteLength(snapshotJson),
            snapshotJson,
            throughSequence: snapshot.throughSequence,
            updatedAt: run.updatedAt,
        });
        if (snapshotExists) {
            transaction
                .update(chatRuntimeSnapshots)
                .set({
                    firstSequence: stored.firstSequence,
                    snapshotBytes: stored.snapshotBytes,
                    snapshotJson: stored.snapshotJson,
                    throughSequence: stored.throughSequence,
                    updatedAt: stored.updatedAt,
                })
                .where(eq(chatRuntimeSnapshots.chatRunId, run.id))
                .run();
        } else {
            transaction.insert(chatRuntimeSnapshots).values(stored).run();
        }
        appendRealtimeMarker(transaction, run.updatedAt);
    }
    return Object.freeze({
        insertedCount,
        run: toChatRunSummary(run),
        snapshot,
    });
}

function updateTranscriptGeneration(
    transaction: ChatTransaction,
    row: ChatTranscriptGenerationRow,
    values: Partial<typeof chatTranscriptGenerations.$inferInsert>,
    at: Date
): ChatTranscriptGenerationRow {
    const updatedAt = toDate(Math.max(getTime(row.updatedAt), getTime(at)));
    const updated = transaction
        .update(chatTranscriptGenerations)
        .set({ ...values, updatedAt, version: row.version + 1 })
        .where(
            and(
                eq(chatTranscriptGenerations.gatewayScope, row.gatewayScope),
                eq(chatTranscriptGenerations.sessionKey, row.sessionKey),
                eq(chatTranscriptGenerations.version, row.version)
            )
        )
        .returning()
        .get();
    if (updated === undefined) {
        throw new ChatRunTransitionError("Chat transcript pointer changed concurrently");
    }
    return parseTranscriptGeneration(updated);
}

function transcriptSessionState(
    row: ChatTranscriptGenerationRow
): ChatTranscriptSessionState {
    return Object.freeze({
        currentGeneration: row.currentGeneration,
        ...(row.providerSessionId === null
            ? {}
            : { providerSessionId: row.providerSessionId }),
        sessionKey: row.sessionKey,
        status: row.status,
    });
}

function advanceTranscriptGeneration(
    transaction: ChatTransaction,
    row: ChatTranscriptGenerationRow,
    input: Readonly<{
        action: ChatTranscriptGenerationChange["reason"];
        at: Date;
        emitRealtimeMarkers?: boolean;
        providerSessionId?: string;
        providerUpdatedAtMs?: number;
        status: "absent" | "ready";
    }>
): ChatTranscriptGenerationChange {
    if (row.currentGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new ChatRunTransitionError("Chat transcript generation is exhausted");
    }
    const activeRows = transaction
        .select()
        .from(chatRuns)
        .where(
            and(
                eq(chatRuns.gatewayScope, row.gatewayScope),
                eq(chatRuns.sessionKey, row.sessionKey),
                eq(chatRuns.transcriptGeneration, row.currentGeneration),
                inArray(chatRuns.state, [...chatActiveRunStates])
            )
        )
        .orderBy(asc(chatRuns.admittedAt), asc(chatRuns.id))
        .all()
        .map((candidate) => parseRun(candidate));
    let boundaryAt = input.at;
    for (const run of activeRows) {
        boundaryAt = toDate(Math.max(getTime(boundaryAt), getTime(run.updatedAt)));
        const updated = transaction
            .update(chatRuns)
            .set({
                failureCode: null,
                failureMessage: null,
                reconciledAt: null,
                reconciliationState: "failed",
                retentionExpiresAt: addMilliseconds(
                    boundaryAt,
                    chatTerminalRetentionMilliseconds
                ),
                state: "unresolved",
                stateVersion: run.stateVersion + 1,
                terminalAt: boundaryAt,
                updatedAt: boundaryAt,
            })
            .where(
                and(eq(chatRuns.id, run.id), eq(chatRuns.stateVersion, run.stateVersion))
            )
            .returning({ id: chatRuns.id })
            .get();
        if (updated === undefined) {
            throw new ChatRunTransitionError(
                "Chat run changed during transcript retirement"
            );
        }
    }
    let lastBoundaryProviderUpdatedAt: Date | null;
    if (input.action === "transport") {
        lastBoundaryProviderUpdatedAt = row.lastBoundaryProviderUpdatedAt;
    } else if (input.providerUpdatedAtMs === undefined) {
        lastBoundaryProviderUpdatedAt = input.at;
    } else {
        lastBoundaryProviderUpdatedAt = toDate(input.providerUpdatedAtMs);
    }
    updateTranscriptGeneration(
        transaction,
        row,
        {
            currentGeneration: row.currentGeneration + 1,
            lastBoundaryAction: input.action,
            lastBoundaryProviderUpdatedAt,
            observedAt: toDate(
                Math.max(
                    row.observedAt === null ? 0 : getTime(row.observedAt),
                    getTime(input.at)
                )
            ),
            pendingAction: null,
            pendingControlId: null,
            pendingPreviousStatus: null,
            providerSessionId:
                input.status === "absent" ? null : (input.providerSessionId ?? null),
            providerUpdatedAt:
                input.providerUpdatedAtMs === undefined
                    ? null
                    : toDate(input.providerUpdatedAtMs),
            status: input.status,
        },
        boundaryAt
    );
    if (input.emitRealtimeMarkers !== false) {
        appendRealtimeMarker(transaction, boundaryAt);
        appendHistoryRealtimeMarker(transaction, boundaryAt);
    }
    return Object.freeze({
        currentGeneration: row.currentGeneration + 1,
        previousGeneration: row.currentGeneration,
        reason: input.action,
        retiredRunIds: Object.freeze(activeRows.map(({ id }) => id)),
        sessionKey: row.sessionKey,
        status: input.status,
    });
}

function orderedRuntimeSnapshots(
    transaction: ChatTransaction,
    gatewayScope: string,
    sessionKey: string,
    transcriptGeneration: number
): readonly ChatRuntimeSnapshot[] {
    const activeRows = transaction
        .select({ run: chatRuns, snapshot: chatRuntimeSnapshots })
        .from(chatRuntimeSnapshots)
        .innerJoin(chatRuns, eq(chatRuns.id, chatRuntimeSnapshots.chatRunId))
        .where(
            and(
                eq(chatRuns.gatewayScope, gatewayScope),
                eq(chatRuns.sessionKey, sessionKey),
                eq(chatRuns.transcriptGeneration, transcriptGeneration),
                inArray(chatRuns.state, [...chatActiveRunStates])
            )
        )
        .orderBy(asc(chatRuns.admittedAt), asc(chatRuns.id))
        .limit(chatActiveRunsPerSessionMaximum)
        .all();
    const settledRows = transaction
        .select({ run: chatRuns, snapshot: chatRuntimeSnapshots })
        .from(chatRuntimeSnapshots)
        .innerJoin(chatRuns, eq(chatRuns.id, chatRuntimeSnapshots.chatRunId))
        .where(
            and(
                eq(chatRuns.gatewayScope, gatewayScope),
                eq(chatRuns.sessionKey, sessionKey),
                eq(chatRuns.transcriptGeneration, transcriptGeneration),
                notInArray(chatRuns.state, [...chatActiveRunStates])
            )
        )
        .orderBy(desc(chatRuns.admittedAt), desc(chatRuns.id))
        .limit(chatRuntimeSnapshotMaximum - activeRows.length)
        .all();
    return [...activeRows, ...settledRows]
        .map(({ run: rawRun, snapshot: rawSnapshot }) => {
            const run = parseRun(rawRun);
            const snapshot = toChatRuntimeSnapshot(
                v.parse(chatRuntimeSnapshotSelectSchema, rawSnapshot)
            );
            return v.parse(chatRuntimeSnapshotSchema, {
                ...snapshot,
                run: toChatRunSummary(run),
            });
        })
        .toSorted(
            (left, right) =>
                left.run.admittedAtMs - right.run.admittedAtMs ||
                compareStrings(left.run.id, right.run.id)
        );
}

type ChatRuntimeDelivery = Readonly<{
    cursor: string;
    event: ChatRuntimeEvent;
}>;

type RuntimeResponseFields = Readonly<{
    cursor: string;
    events: readonly ChatRuntimeDelivery[];
    hasMore: boolean;
    resetRequired: boolean;
    sessionKey: string;
    transcriptGeneration: number;
}>;

function runtimeResponseValue(
    fields: RuntimeResponseFields,
    runs: readonly ChatRuntimeSnapshot[]
): ChatRuntimeOutput {
    return {
        cursor: fields.cursor,
        externalRuns: [],
        externalRunsTruncated: false,
        events: [...fields.events],
        hasMore: fields.hasMore,
        resetRequired: fields.resetRequired,
        runs: [...runs],
        sessionKey: fields.sessionKey,
        transcriptGeneration: fields.transcriptGeneration,
    };
}

function runtimeResponseBytes(
    fields: RuntimeResponseFields,
    runs: readonly ChatRuntimeSnapshot[]
): number {
    return utf8ByteLength(JSON.stringify(runtimeResponseValue(fields, runs)));
}

function compactRuntimeSnapshot(snapshot: ChatRuntimeSnapshot): ChatRuntimeSnapshot {
    if (snapshot.parts.length === 0 && snapshot.plan === undefined) return snapshot;
    return v.parse(chatRuntimeSnapshotSchema, {
        firstSequence: snapshot.firstSequence,
        parts: [],
        projectionTruncated: true,
        run: snapshot.run,
        throughSequence: snapshot.throughSequence,
    });
}

function compareRuntimeSnapshots(
    left: ChatRuntimeSnapshot,
    right: ChatRuntimeSnapshot
): number {
    return (
        left.run.admittedAtMs - right.run.admittedAtMs ||
        compareStrings(left.run.id, right.run.id)
    );
}

/**
 * Retains every active identity, then the newest settled identities, and spends
 * remaining bytes restoring full projections. A compact snapshot is explicit
 * about omitted detail and therefore never fabricates an authoritative view.
 * @param snapshots Validated durable snapshots.
 * @param fields Runtime response envelope fields.
 * @returns The bounded identity-preserving snapshot projection.
 */
function budgetRuntimeSnapshots(
    snapshots: readonly ChatRuntimeSnapshot[],
    fields: RuntimeResponseFields
): readonly ChatRuntimeSnapshot[] {
    const active = snapshots.filter(({ run }) => chatActiveRunStateSet.has(run.state));
    const settled = snapshots.filter(({ run }) => !chatActiveRunStateSet.has(run.state));
    let selected = active
        .map((snapshot) => compactRuntimeSnapshot(snapshot))
        .toSorted(compareRuntimeSnapshots);
    if (runtimeResponseBytes(fields, selected) > chatRuntimeDurableResponseMaximumBytes) {
        throw new ChatRunBudgetExceededError();
    }

    for (const snapshot of settled.toReversed()) {
        const candidate = [...selected, compactRuntimeSnapshot(snapshot)].toSorted(
            compareRuntimeSnapshots
        );
        if (
            runtimeResponseBytes(fields, candidate) <=
            chatRuntimeDurableResponseMaximumBytes
        ) {
            selected = candidate;
        }
    }

    const fullById = new Map(snapshots.map((snapshot) => [snapshot.run.id, snapshot]));
    const upgradeOrder = [
        ...selected
            .filter(({ run }) => chatActiveRunStateSet.has(run.state))
            .toReversed(),
        ...selected
            .filter(({ run }) => !chatActiveRunStateSet.has(run.state))
            .toReversed(),
    ];
    for (const compact of upgradeOrder) {
        const full = fullById.get(compact.run.id);
        if (full === undefined || full === compact) continue;
        const candidate = selected.map((snapshot) =>
            snapshot.run.id === compact.run.id ? full : snapshot
        );
        if (
            runtimeResponseBytes(fields, candidate) <=
            chatRuntimeDurableResponseMaximumBytes
        ) {
            selected = candidate;
        }
    }
    return Object.freeze(selected);
}

function runtimePage(
    snapshots: readonly ChatRuntimeSnapshot[],
    fields: RuntimeResponseFields
): ChatRuntimeOutput {
    const runs = budgetRuntimeSnapshots(snapshots, fields);
    return v.parse(chatRuntimeOutputSchema, runtimeResponseValue(fields, runs));
}

/**
 * Creates the durable chat admission, journal, snapshot, and cursor repository.
 * @param database Owned SQLite database.
 * @param writeAdmission Immediate-transaction admission controller.
 * @param gatewayScope Stable credential-scope fingerprint.
 * @param nowMs Current-time source.
 * @param wakeEventPump Post-commit durable outbox wakeup.
 * @returns The bounded durable chat repository.
 */
export function createChatRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission,
    gatewayScope = "default",
    nowMs: () => number = Date.now,
    wakeEventPump: () => Promise<void> = () => Promise.resolve()
): ChatRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: ChatTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const read = <T>(callback: (transaction: ChatTransaction) => T): T =>
        runTransaction(callback, { behavior: "deferred" });
    const write = async <T>(
        callback: (transaction: ChatTransaction) => T
    ): Promise<T> => {
        const output = await writeAdmission.run((markTransactionStarted) =>
            runTransaction(
                (transaction) => {
                    markTransactionStarted();
                    return callback(transaction);
                },
                { behavior: "immediate" }
            )
        );
        try {
            await wakeEventPump();
        } catch {
            // The durable row and outbox marker already committed. Adaptive polling
            // remains authoritative when the best-effort immediate wake fails.
        }
        return output;
    };

    const repository: ChatRepository = {
        acknowledgeDispatch(runId, providerRunId, at = toDate(nowMs())) {
            return write((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined) throw new ChatRunNotFoundError();
                if (run.dispatchAttemptedAt === null) {
                    throw new ChatRunTransitionError("Chat dispatch was not admitted");
                }
                if (run.providerRunId !== null) {
                    if (run.providerRunId !== providerRunId) {
                        throw new ChatAdmissionConflictError();
                    }
                    return toChatRunSummary(run);
                }
                const updatedAt = toDate(Math.max(getTime(run.updatedAt), getTime(at)));
                const updated = transaction
                    .update(chatRuns)
                    .set({
                        providerAcknowledgedAt: updatedAt,
                        providerRunId,
                        reconciliationState: "runtime-authoritative",
                        stateVersion: run.stateVersion + 1,
                        updatedAt,
                    })
                    .where(
                        and(
                            eq(chatRuns.id, run.id),
                            eq(chatRuns.stateVersion, run.stateVersion)
                        )
                    )
                    .returning()
                    .get();
                if (updated === undefined) throw new ChatRunTransitionError();
                appendRealtimeMarker(transaction, updatedAt);
                return toChatRunSummary(parseRun(updated));
            });
        },
        admit(rawInput, actor, at = toDate(nowMs())) {
            const input = v.parse(chatSendInputSchema, rawInput);
            const requestJson = JSON.stringify(input);
            const requestSha256 = sha256Hex(requestJson);
            return write((transaction) => {
                const transcript = ensureTranscriptGeneration(
                    transaction,
                    gatewayScope,
                    input.sessionKey,
                    at
                );
                if (transcript.status !== "ready") {
                    throw new ChatTranscriptUnavailableError();
                }
                const replay = transaction
                    .select()
                    .from(chatRuns)
                    .where(
                        and(
                            eq(chatRuns.actorKind, actor.kind),
                            eq(chatRuns.actorId, actor.id),
                            eq(chatRuns.idempotencyKey, input.idempotencyKey)
                        )
                    )
                    .get();
                if (replay !== undefined) {
                    const run = parseRun(replay);
                    if (
                        run.id !== input.clientRunId ||
                        run.gatewayScope !== gatewayScope ||
                        run.sessionKey !== input.sessionKey ||
                        run.transcriptGeneration !== transcript.currentGeneration ||
                        run.requestSha256 !== requestSha256 ||
                        run.requestJson !== requestJson
                    ) {
                        throw new ChatAdmissionConflictError();
                    }
                    return Object.freeze({
                        admission: "replayed" as const,
                        run: toChatRunSummary(run),
                    });
                }
                if (existingRun(transaction, input.clientRunId) !== undefined) {
                    throw new ChatAdmissionConflictError();
                }
                const providerIntent = transaction
                    .select({ id: chatRuns.id })
                    .from(chatRuns)
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, input.sessionKey),
                            eq(
                                chatRuns.transcriptGeneration,
                                transcript.currentGeneration
                            ),
                            eq(chatRuns.idempotencyKey, input.idempotencyKey)
                        )
                    )
                    .get();
                if (providerIntent !== undefined) {
                    throw new ChatAdmissionConflictError();
                }
                const activeStates = [...chatActiveRunStates];
                const sessionCount = requiredCount(
                    transaction
                        .select({ value: count() })
                        .from(chatRuns)
                        .where(
                            and(
                                eq(chatRuns.gatewayScope, gatewayScope),
                                eq(chatRuns.sessionKey, input.sessionKey),
                                eq(
                                    chatRuns.transcriptGeneration,
                                    transcript.currentGeneration
                                ),
                                inArray(chatRuns.state, activeStates)
                            )
                        )
                        .get()
                );
                if (sessionCount >= chatActiveRunsPerSessionMaximum) {
                    throw new ChatAdmissionCapacityError("session");
                }
                const processCount = requiredCount(
                    transaction
                        .select({ value: count() })
                        .from(chatRuns)
                        .innerJoin(
                            chatTranscriptGenerations,
                            and(
                                eq(
                                    chatTranscriptGenerations.gatewayScope,
                                    chatRuns.gatewayScope
                                ),
                                eq(
                                    chatTranscriptGenerations.sessionKey,
                                    chatRuns.sessionKey
                                ),
                                eq(
                                    chatTranscriptGenerations.currentGeneration,
                                    chatRuns.transcriptGeneration
                                )
                            )
                        )
                        .where(
                            and(
                                eq(chatRuns.gatewayScope, gatewayScope),
                                eq(chatTranscriptGenerations.status, "ready"),
                                inArray(chatRuns.state, activeStates)
                            )
                        )
                        .get()
                );
                if (processCount >= chatActiveRunsPerProcessMaximum) {
                    throw new ChatAdmissionCapacityError("process");
                }
                const inserted = transaction
                    .insert(chatRuns)
                    .values(
                        v.parse(chatRunInsertSchema, {
                            actorId: actor.id,
                            actorKind: actor.kind,
                            admittedAt: at,
                            cancelRequestedAt: null,
                            dispatchAttemptedAt: null,
                            eventBytes: 0,
                            eventCount: 0,
                            failureCode: null,
                            failureMessage: null,
                            gatewayScope,
                            historyMessageId: null,
                            id: input.clientRunId,
                            idempotencyKey: input.idempotencyKey,
                            lastEventSequence: 0,
                            providerAcknowledgedAt: null,
                            providerRunId: null,
                            reconciledAt: null,
                            reconciliationState: "pending",
                            requestJson,
                            requestSha256,
                            retentionExpiresAt: null,
                            sessionKey: input.sessionKey,
                            state: "admitted",
                            stateVersion: 1,
                            terminalAt: null,
                            transcriptGeneration: transcript.currentGeneration,
                            updatedAt: at,
                        })
                    )
                    .returning()
                    .get();
                if (inserted === undefined)
                    throw new Error("Chat admission returned no row");
                const appended = appendEventsInTransaction(
                    transaction,
                    parseRun(inserted),
                    [
                        {
                            ...(input.attachmentTicketId === undefined
                                ? {}
                                : { attachmentTicketId: input.attachmentTicketId }),
                            idempotencyKey: input.idempotencyKey,
                            kind: "user",
                            occurredAtMs: getTime(at),
                            text: input.message,
                        },
                    ]
                );
                return Object.freeze({
                    admission: "created" as const,
                    run: appended.run,
                });
            });
        },
        appendEvents(runId, events) {
            if (events.length === 0 || events.length > 256) {
                return Promise.reject(new ChatRunBudgetExceededError());
            }
            return write((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined) throw new ChatRunNotFoundError();
                return appendEventsInTransaction(transaction, run, events);
            });
        },
        beginDispatch(runId, at = toDate(nowMs())) {
            return write((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined) throw new ChatRunNotFoundError();
                if (run.dispatchAttemptedAt !== null || run.state !== "admitted") {
                    return Object.freeze({
                        run: toChatRunSummary(run),
                        shouldDispatch: false,
                    });
                }
                const updatedAt = toDate(Math.max(getTime(run.updatedAt), getTime(at)));
                const updated = transaction
                    .update(chatRuns)
                    .set({
                        dispatchAttemptedAt: updatedAt,
                        stateVersion: run.stateVersion + 1,
                        updatedAt,
                    })
                    .where(
                        and(
                            eq(chatRuns.id, run.id),
                            eq(chatRuns.state, "admitted"),
                            eq(chatRuns.stateVersion, run.stateVersion)
                        )
                    )
                    .returning()
                    .get();
                if (updated === undefined) throw new ChatRunTransitionError();
                return Object.freeze({
                    run: toChatRunSummary(parseRun(updated)),
                    shouldDispatch: true,
                });
            });
        },
        findByProviderRunId(sessionKey, providerRunId) {
            return read((transaction) => {
                const row = transaction
                    .select({ run: chatRuns })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                            eq(
                                chatTranscriptGenerations.currentGeneration,
                                chatRuns.transcriptGeneration
                            )
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, sessionKey),
                            eq(chatTranscriptGenerations.status, "ready"),
                            eq(chatRuns.providerRunId, providerRunId)
                        )
                    )
                    .get();
                return row === undefined
                    ? undefined
                    : toChatRunSummary(parseRun(row.run));
            });
        },
        findByProviderCorrelation(sessionKey, providerRunId) {
            return read((transaction) => {
                const rows = transaction
                    .select({ run: chatRuns })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                            eq(
                                chatTranscriptGenerations.currentGeneration,
                                chatRuns.transcriptGeneration
                            )
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, sessionKey),
                            eq(chatTranscriptGenerations.status, "ready"),
                            isNotNull(chatRuns.dispatchAttemptedAt),
                            or(
                                eq(chatRuns.providerRunId, providerRunId),
                                eq(chatRuns.idempotencyKey, providerRunId)
                            )
                        )
                    )
                    .limit(2)
                    .all();
                if (rows.length > 1) {
                    throw new ChatAdmissionConflictError();
                }
                return rows.length === 0
                    ? undefined
                    : toChatRunSummary(parseRun(rows[0]!.run));
            });
        },
        isRetiredProviderCorrelation(sessionKey, providerRunId) {
            return read((transaction) => {
                const row = transaction
                    .select({
                        generation: chatRuns.transcriptGeneration,
                        status: chatTranscriptGenerations.status,
                    })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey)
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, sessionKey),
                            isNotNull(chatRuns.dispatchAttemptedAt),
                            or(
                                eq(chatRuns.providerRunId, providerRunId),
                                eq(chatRuns.idempotencyKey, providerRunId)
                            )
                        )
                    )
                    .limit(1)
                    .get();
                return (
                    row !== undefined &&
                    (row.status !== "ready" ||
                        row.generation !==
                            existingTranscriptGeneration(
                                transaction,
                                gatewayScope,
                                sessionKey
                            )?.currentGeneration)
                );
            });
        },
        findRun(runId) {
            return read((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                return run === undefined ? undefined : toChatRunSummary(run);
            });
        },
        listRecoveryCandidates() {
            return read((transaction) =>
                transaction
                    .select({ run: chatRuns })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                            eq(
                                chatTranscriptGenerations.currentGeneration,
                                chatRuns.transcriptGeneration
                            )
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatTranscriptGenerations.status, "ready"),
                            inArray(chatRuns.state, [...chatActiveRunStates])
                        )
                    )
                    .orderBy(asc(chatRuns.admittedAt), asc(chatRuns.id))
                    .all()
                    .map(({ run: row }) => {
                        const run = parseRun(row);
                        return Object.freeze({
                            dispatchAttempted: run.dispatchAttemptedAt !== null,
                            request: v.parse(
                                chatSendInputSchema,
                                JSON.parse(run.requestJson) as unknown
                            ),
                            run: toChatRunSummary(run),
                        });
                    })
            );
        },
        listTranscriptRecoveryCandidates(sessionKey) {
            return read((transaction) =>
                transaction
                    .select({ run: chatRuns })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                            eq(
                                chatTranscriptGenerations.currentGeneration,
                                chatRuns.transcriptGeneration
                            )
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, sessionKey),
                            inArray(chatRuns.state, [...chatActiveRunStates])
                        )
                    )
                    .orderBy(asc(chatRuns.admittedAt), asc(chatRuns.id))
                    .all()
                    .map(({ run: rawRun }) => {
                        const run = parseRun(rawRun);
                        return Object.freeze({
                            dispatchAttempted: run.dispatchAttemptedAt !== null,
                            request: v.parse(
                                chatSendInputSchema,
                                JSON.parse(run.requestJson) as unknown
                            ),
                            run: toChatRunSummary(run),
                        });
                    })
            );
        },
        listRecoverableRuns() {
            return read((transaction) =>
                transaction
                    .select({ run: chatRuns })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                            eq(
                                chatTranscriptGenerations.currentGeneration,
                                chatRuns.transcriptGeneration
                            )
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatTranscriptGenerations.status, "ready"),
                            inArray(chatRuns.state, [...chatActiveRunStates])
                        )
                    )
                    .orderBy(asc(chatRuns.admittedAt), asc(chatRuns.id))
                    .all()
                    .map(({ run }) => toChatRunSummary(parseRun(run)))
            );
        },
        listProviderRunWatermarks(sessionKey) {
            return read((transaction) =>
                transaction
                    .select({ run: chatRuns })
                    .from(chatRuns)
                    .innerJoin(
                        chatTranscriptGenerations,
                        and(
                            eq(
                                chatTranscriptGenerations.gatewayScope,
                                chatRuns.gatewayScope
                            ),
                            eq(chatTranscriptGenerations.sessionKey, chatRuns.sessionKey),
                            eq(
                                chatTranscriptGenerations.currentGeneration,
                                chatRuns.transcriptGeneration
                            )
                        )
                    )
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, sessionKey),
                            eq(chatTranscriptGenerations.status, "ready"),
                            isNotNull(chatRuns.dispatchAttemptedAt),
                            inArray(chatRuns.state, [...chatActiveRunStates])
                        )
                    )
                    .orderBy(asc(chatRuns.admittedAt), asc(chatRuns.id))
                    .all()
                    .map(({ run: rawRun }) => {
                        const run = parseRun(rawRun);
                        const request = v.parse(
                            chatSendInputSchema,
                            JSON.parse(run.requestJson) as unknown
                        );
                        const lastProviderSequence = requiredCursor(
                            transaction
                                .select({
                                    value: max(chatRunEvents.providerSequenceEnd),
                                })
                                .from(chatRunEvents)
                                .where(
                                    and(
                                        eq(chatRunEvents.chatRunId, run.id),
                                        isNotNull(chatRunEvents.providerSequenceEnd)
                                    )
                                )
                                .get()
                        );
                        return Object.freeze({
                            lastProviderSequence,
                            providerRunId: run.providerRunId ?? request.idempotencyKey,
                        });
                    })
            );
        },
        beginTranscriptControl({ action, controlId, key, occurredAtMs }) {
            const at = toDate(occurredAtMs);
            return write((transaction) => {
                const row = ensureTranscriptGeneration(
                    transaction,
                    gatewayScope,
                    key,
                    at
                );
                if (
                    row.status === "control-pending" &&
                    row.pendingAction === action &&
                    row.pendingControlId === controlId
                ) {
                    return;
                }
                if (row.status === "control-pending" || row.status === "reconciling") {
                    throw new ChatTranscriptUnavailableError();
                }
                updateTranscriptGeneration(
                    transaction,
                    row,
                    {
                        observedAt: toDate(
                            Math.max(getTime(row.observedAt ?? at), occurredAtMs)
                        ),
                        pendingAction: action,
                        pendingControlId: controlId,
                        pendingPreviousStatus: row.status,
                        status: "control-pending",
                    },
                    at
                );
            });
        },
        failTranscriptControl({ action, controlId, key, occurredAtMs }) {
            return write((transaction) => {
                const row = existingTranscriptGeneration(transaction, gatewayScope, key);
                if (
                    row?.status !== "control-pending" ||
                    row.pendingAction !== action ||
                    row.pendingControlId !== controlId
                ) {
                    return;
                }
                updateTranscriptGeneration(
                    transaction,
                    row,
                    {
                        pendingAction: null,
                        pendingControlId: null,
                        pendingPreviousStatus: null,
                        status: row.pendingPreviousStatus ?? "ready",
                    },
                    toDate(occurredAtMs)
                );
            });
        },
        listReconcilingTranscripts() {
            return read((transaction) =>
                transaction
                    .select()
                    .from(chatTranscriptGenerations)
                    .where(
                        and(
                            eq(chatTranscriptGenerations.gatewayScope, gatewayScope),
                            eq(chatTranscriptGenerations.status, "reconciling")
                        )
                    )
                    .orderBy(asc(chatTranscriptGenerations.sessionKey))
                    .all()
                    .map((row) => transcriptSessionState(parseTranscriptGeneration(row)))
            );
        },
        markTranscriptTransportBoundary(occurredAtMs = nowMs()) {
            const at = toDate(occurredAtMs);
            return write((transaction) => {
                const changes: ChatTranscriptGenerationChange[] = [];
                let historyChanged = false;
                let runtimeChanged = false;
                const rows = transaction
                    .select()
                    .from(chatTranscriptGenerations)
                    .where(eq(chatTranscriptGenerations.gatewayScope, gatewayScope))
                    .orderBy(asc(chatTranscriptGenerations.sessionKey))
                    .all()
                    .map((candidate) => parseTranscriptGeneration(candidate));
                for (const row of rows) {
                    if (row.status === "control-pending") continue;
                    const activeCount = requiredCount(
                        transaction
                            .select({ value: count() })
                            .from(chatRuns)
                            .where(
                                and(
                                    eq(chatRuns.gatewayScope, gatewayScope),
                                    eq(chatRuns.sessionKey, row.sessionKey),
                                    eq(
                                        chatRuns.transcriptGeneration,
                                        row.currentGeneration
                                    ),
                                    inArray(chatRuns.state, [...chatActiveRunStates])
                                )
                            )
                            .get()
                    );
                    if (activeCount > 0) {
                        if (row.status !== "reconciling") {
                            updateTranscriptGeneration(
                                transaction,
                                row,
                                {
                                    lastBoundaryAction: "transport",
                                    status: "reconciling",
                                },
                                at
                            );
                            runtimeChanged = true;
                        }
                        continue;
                    }
                    changes.push(
                        advanceTranscriptGeneration(transaction, row, {
                            action: "transport",
                            at,
                            emitRealtimeMarkers: false,
                            ...(row.providerSessionId === null
                                ? {}
                                : { providerSessionId: row.providerSessionId }),
                            ...(row.providerUpdatedAt === null
                                ? {}
                                : {
                                      providerUpdatedAtMs: getTime(row.providerUpdatedAt),
                                  }),
                            status: row.status === "absent" ? "absent" : "ready",
                        })
                    );
                    historyChanged = true;
                    runtimeChanged = true;
                }
                if (runtimeChanged) appendRealtimeMarker(transaction, at);
                if (historyChanged) appendHistoryRealtimeMarker(transaction, at);
                return Object.freeze(changes);
            });
        },
        observeTranscriptLifecycleEvent(event: ChatTranscriptLifecycleEvent) {
            if (event.sessionKey === undefined) return Promise.resolve([]);
            if (event.reason === "compact" && event.compacted !== true) {
                return Promise.resolve([]);
            }
            const at = toDate(event.occurredAtMs);
            return write((transaction) => {
                const row = ensureTranscriptGeneration(
                    transaction,
                    gatewayScope,
                    event.sessionKey!,
                    at
                );
                const boundaryAtMs = event.updatedAtMs ?? event.occurredAtMs;
                if (
                    row.lastBoundaryProviderUpdatedAt !== null &&
                    getTime(row.lastBoundaryProviderUpdatedAt) >= boundaryAtMs &&
                    (event.updatedAtMs !== undefined ||
                        row.lastBoundaryAction === event.reason)
                ) {
                    return Object.freeze([]);
                }
                let providerSessionId: string | undefined;
                if (event.reason === "delete") {
                    // A provider-side delete intentionally leaves the generation absent.
                } else if (event.sessionId !== undefined) {
                    providerSessionId = event.sessionId;
                } else if (row.providerSessionId !== null) {
                    providerSessionId = row.providerSessionId;
                }
                return Object.freeze([
                    advanceTranscriptGeneration(transaction, row, {
                        action: event.reason,
                        at,
                        ...(providerSessionId === undefined ? {} : { providerSessionId }),
                        ...(event.updatedAtMs === undefined
                            ? {}
                            : { providerUpdatedAtMs: event.updatedAtMs }),
                        status: event.reason === "delete" ? "absent" : "ready",
                    }),
                ]);
            });
        },
        observeTranscriptSnapshot(snapshot) {
            const at = toDate(snapshot.observedAtMs);
            return write((transaction) => {
                const changes: ChatTranscriptGenerationChange[] = [];
                const seen = new Set<string>();
                for (const session of snapshot.sessions) {
                    seen.add(session.key);
                    const row = ensureTranscriptGeneration(
                        transaction,
                        gatewayScope,
                        session.key,
                        at
                    );
                    const newerThanFence =
                        row.observedAt === null ||
                        snapshot.observedAtMs > getTime(row.observedAt);
                    if (row.status === "control-pending") {
                        if (newerThanFence) {
                            changes.push(
                                advanceTranscriptGeneration(transaction, row, {
                                    action: row.pendingAction!,
                                    at,
                                    ...(session.sessionId === undefined
                                        ? {}
                                        : { providerSessionId: session.sessionId }),
                                    ...(session.updatedAtMs === undefined
                                        ? {}
                                        : {
                                              providerUpdatedAtMs: session.updatedAtMs,
                                          }),
                                    status: "ready",
                                })
                            );
                        }
                        continue;
                    }
                    if (row.status === "reconciling") continue;
                    if (!newerThanFence) continue;
                    if (
                        row.status === "absent" ||
                        (row.providerSessionId !== null &&
                            session.sessionId !== undefined &&
                            row.providerSessionId !== session.sessionId)
                    ) {
                        changes.push(
                            advanceTranscriptGeneration(transaction, row, {
                                action: "new",
                                at,
                                ...(session.sessionId === undefined
                                    ? {}
                                    : { providerSessionId: session.sessionId }),
                                ...(session.updatedAtMs === undefined
                                    ? {}
                                    : {
                                          providerUpdatedAtMs: session.updatedAtMs,
                                      }),
                                status: "ready",
                            })
                        );
                        continue;
                    }
                    updateTranscriptGeneration(
                        transaction,
                        row,
                        {
                            observedAt: at,
                            providerSessionId: session.sessionId ?? null,
                            providerUpdatedAt:
                                session.updatedAtMs === undefined
                                    ? null
                                    : toDate(session.updatedAtMs),
                        },
                        at
                    );
                }
                if (!snapshot.projectionTruncated) {
                    const missingRows = transaction
                        .select()
                        .from(chatTranscriptGenerations)
                        .where(eq(chatTranscriptGenerations.gatewayScope, gatewayScope))
                        .all()
                        .map((candidate) => parseTranscriptGeneration(candidate))
                        .filter((row) => !seen.has(row.sessionKey));
                    for (const row of missingRows) {
                        if (row.status === "reconciling") continue;
                        const newerThanFence =
                            row.observedAt === null ||
                            snapshot.observedAtMs > getTime(row.observedAt);
                        if (!newerThanFence) continue;
                        if (row.status === "absent") {
                            updateTranscriptGeneration(
                                transaction,
                                row,
                                { observedAt: at },
                                at
                            );
                            continue;
                        }
                        changes.push(
                            advanceTranscriptGeneration(transaction, row, {
                                action: row.pendingAction ?? "delete",
                                at,
                                status: "absent",
                            })
                        );
                    }
                }
                return Object.freeze(changes);
            });
        },
        reconcileTranscript(input) {
            const at = toDate(input.observedAtMs);
            return write((transaction) => {
                const row = existingTranscriptGeneration(
                    transaction,
                    gatewayScope,
                    input.sessionKey
                );
                if (row?.status !== "reconciling") return Object.freeze([]);
                if (input.represented) {
                    updateTranscriptGeneration(
                        transaction,
                        row,
                        {
                            observedAt: at,
                            providerSessionId: input.providerSessionId ?? null,
                            providerUpdatedAt:
                                input.providerUpdatedAtMs === undefined
                                    ? null
                                    : toDate(input.providerUpdatedAtMs),
                            status: "ready",
                        },
                        at
                    );
                    appendRealtimeMarker(transaction, at);
                    return Object.freeze([]);
                }
                return Object.freeze([
                    advanceTranscriptGeneration(transaction, row, {
                        action: "transport",
                        at,
                        ...(input.providerSessionId === undefined
                            ? {}
                            : { providerSessionId: input.providerSessionId }),
                        ...(input.providerUpdatedAtMs === undefined
                            ? {}
                            : {
                                  providerUpdatedAtMs: input.providerUpdatedAtMs,
                              }),
                        status: "ready",
                    }),
                ]);
            });
        },
        readTranscriptState(sessionKey) {
            return read((transaction) => {
                const row = existingTranscriptGeneration(
                    transaction,
                    gatewayScope,
                    sessionKey
                );
                return row === undefined
                    ? Object.freeze({
                          currentGeneration: 1,
                          sessionKey,
                          status: "ready" as const,
                      })
                    : transcriptSessionState(row);
            });
        },
        settleUnchangedTranscriptControl({ controlId, key, occurredAtMs }) {
            return write((transaction) => {
                const row = existingTranscriptGeneration(transaction, gatewayScope, key);
                if (
                    row?.status !== "control-pending" ||
                    row.pendingAction !== "compact" ||
                    row.pendingControlId !== controlId
                ) {
                    return;
                }
                updateTranscriptGeneration(
                    transaction,
                    row,
                    {
                        pendingAction: null,
                        pendingControlId: null,
                        pendingPreviousStatus: null,
                        status: row.pendingPreviousStatus ?? "ready",
                    },
                    toDate(occurredAtMs)
                );
            });
        },
        markOutcomeUnknown(runId, at = toDate(nowMs())) {
            return write((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined) throw new ChatRunNotFoundError();
                if (
                    ["cancelled", "completed", "failed", "unresolved"].includes(run.state)
                ) {
                    return toChatRunSummary(run);
                }
                const updatedAt = toDate(Math.max(getTime(run.updatedAt), getTime(at)));
                const updated = transaction
                    .update(chatRuns)
                    .set({
                        state: "outcome-unknown",
                        stateVersion: run.stateVersion + 1,
                        updatedAt,
                    })
                    .where(
                        and(
                            eq(chatRuns.id, run.id),
                            eq(chatRuns.stateVersion, run.stateVersion)
                        )
                    )
                    .returning()
                    .get();
                if (updated === undefined) throw new ChatRunTransitionError();
                appendRealtimeMarker(transaction, updatedAt);
                return toChatRunSummary(parseRun(updated));
            });
        },
        pruneExpired(at = toDate(nowMs()), limit = 100) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
                return Promise.reject(new RangeError("Chat retention limit is invalid"));
            }
            return write((transaction) => {
                const ids = transaction
                    .select({ id: chatRuns.id })
                    .from(chatRuns)
                    .where(
                        and(
                            isNotNull(chatRuns.retentionExpiresAt),
                            lte(chatRuns.retentionExpiresAt, at)
                        )
                    )
                    .orderBy(asc(chatRuns.retentionExpiresAt), asc(chatRuns.id))
                    .limit(limit)
                    .all()
                    .map(({ id }) => id);
                if (ids.length > 0) {
                    transaction.delete(chatRuns).where(inArray(chatRuns.id, ids)).run();
                    appendRealtimeMarker(transaction, at);
                }
                return ids.length;
            });
        },
        readMetrics() {
            return read((transaction) => {
                const countRuns = (states?: readonly ChatRunState[]): number =>
                    requiredCount(
                        transaction
                            .select({ value: count() })
                            .from(chatRuns)
                            .where(
                                states === undefined
                                    ? undefined
                                    : inArray(chatRuns.state, [...states])
                            )
                            .get()
                    );
                const aggregate = (column: typeof chatRuns.eventBytes): number =>
                    requiredCount(
                        transaction
                            .select({
                                value: sql<number>`coalesce(sum(${column}), 0)`,
                            })
                            .from(chatRuns)
                            .get()
                    );
                return Object.freeze({
                    activeRuns: countRuns(chatActiveRunStates),
                    failedOrUnknownRuns: countRuns([
                        "failed",
                        "interrupted",
                        "outcome-unknown",
                        "unresolved",
                    ]),
                    retainedEventBytes: aggregate(chatRuns.eventBytes),
                    retainedEvents: aggregate(chatRuns.eventCount),
                    retainedRuns: countRuns(),
                    retainedSnapshotBytes: requiredCount(
                        transaction
                            .select({
                                value: sql<number>`coalesce(sum(${chatRuntimeSnapshots.snapshotBytes}), 0)`,
                            })
                            .from(chatRuntimeSnapshots)
                            .get()
                    ),
                    retainedSnapshots: requiredCount(
                        transaction
                            .select({ value: count() })
                            .from(chatRuntimeSnapshots)
                            .get()
                    ),
                });
            });
        },
        readRuntime(rawInput) {
            const validated = v.parse(chatRuntimeInputSchema, rawInput);
            return read((transaction) => {
                const afterCursor = Number(validated.afterCursor);
                const transcriptGeneration =
                    existingTranscriptGeneration(
                        transaction,
                        gatewayScope,
                        validated.sessionKey
                    )?.currentGeneration ?? 1;
                const headCursor = requiredCursor(
                    transaction
                        .select({ value: max(chatRunEvents.id) })
                        .from(chatRunEvents)
                        .get()
                );
                const snapshots = orderedRuntimeSnapshots(
                    transaction,
                    gatewayScope,
                    validated.sessionKey,
                    transcriptGeneration
                );
                if (
                    validated.afterTranscriptGeneration !== transcriptGeneration ||
                    afterCursor > headCursor
                ) {
                    return runtimePage(snapshots, {
                        cursor: String(headCursor),
                        events: [],
                        hasMore: false,
                        resetRequired: true,
                        sessionKey: validated.sessionKey,
                        transcriptGeneration,
                    });
                }
                const rows = transaction
                    .select({ event: chatRunEvents })
                    .from(chatRunEvents)
                    .innerJoin(chatRuns, eq(chatRuns.id, chatRunEvents.chatRunId))
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, validated.sessionKey),
                            eq(chatRuns.transcriptGeneration, transcriptGeneration),
                            gt(chatRunEvents.id, afterCursor)
                        )
                    )
                    .orderBy(asc(chatRunEvents.id))
                    .limit(chatRuntimeCatchUpMaximumEvents + 1)
                    .all();
                if (rows.length > chatRuntimeCatchUpMaximumEvents) {
                    return runtimePage(snapshots, {
                        cursor: String(headCursor),
                        events: [],
                        hasMore: false,
                        resetRequired: true,
                        sessionKey: validated.sessionKey,
                        transcriptGeneration,
                    });
                }
                const candidates = rows
                    .slice(0, validated.limit)
                    .map(({ event: rawEvent }) => {
                        const record = v.parse(chatRunEventSelectSchema, rawEvent);
                        return {
                            cursor: String(record.id),
                            event: toChatRuntimeEvent(record),
                        };
                    });
                const minimumRuns = snapshots
                    .filter(({ run }) => chatActiveRunStateSet.has(run.state))
                    .map((snapshot) => compactRuntimeSnapshot(snapshot))
                    .toSorted(compareRuntimeSnapshots);
                const deliveries: ChatRuntimeDelivery[] = [];
                for (const delivery of candidates) {
                    const candidate = [...deliveries, delivery];
                    const hasMore = rows.length > candidate.length;
                    const fields: RuntimeResponseFields = {
                        cursor: hasMore ? delivery.cursor : String(headCursor),
                        events: candidate,
                        hasMore,
                        resetRequired: false,
                        sessionKey: validated.sessionKey,
                        transcriptGeneration,
                    };
                    if (
                        runtimeResponseBytes(fields, minimumRuns) >
                        chatRuntimeDurableResponseMaximumBytes
                    ) {
                        break;
                    }
                    deliveries.push(delivery);
                }
                if (rows.length > 0 && deliveries.length === 0) {
                    // A valid but unusually large first event can always be superseded by the
                    // authoritative bounded snapshot, which also advances the cursor.
                    return runtimePage(snapshots, {
                        cursor: String(headCursor),
                        events: [],
                        hasMore: false,
                        resetRequired: true,
                        sessionKey: validated.sessionKey,
                        transcriptGeneration,
                    });
                }
                const hasMore = rows.length > deliveries.length;
                // Global event ids belonging to other sessions are ordinary holes. Once this
                // transaction has no remaining same-session rows, advancing to the global head
                // safely skips those ids; while paginating, only the last delivered id is used.
                const cursor = hasMore
                    ? (deliveries.at(-1)?.cursor ?? String(afterCursor))
                    : String(headCursor);
                return runtimePage(snapshots, {
                    cursor,
                    events: deliveries,
                    hasMore,
                    resetRequired: false,
                    sessionKey: validated.sessionKey,
                    transcriptGeneration,
                });
            });
        },
        readIntent(runId) {
            return read((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined) return;
                return Object.freeze({
                    dispatchAttempted: run.dispatchAttemptedAt !== null,
                    request: v.parse(
                        chatSendInputSchema,
                        JSON.parse(run.requestJson) as unknown
                    ),
                    run: toChatRunSummary(run),
                });
            });
        },
        signalRuntimeChanged(at = toDate(nowMs())) {
            return write((transaction) => {
                appendRealtimeMarker(transaction, at);
            });
        },
        signalHistoryChanged(at = toDate(nowMs())) {
            return write((transaction) => {
                appendHistoryRealtimeMarker(transaction, at);
            });
        },
        settleUnresolved(runId, at = toDate(nowMs())) {
            return write((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined) throw new ChatRunNotFoundError();
                if (
                    ["cancelled", "completed", "failed", "unresolved"].includes(run.state)
                ) {
                    return toChatRunSummary(run);
                }
                const updatedAt = toDate(Math.max(getTime(run.updatedAt), getTime(at)));
                const updated = transaction
                    .update(chatRuns)
                    .set({
                        failureCode: null,
                        failureMessage: null,
                        reconciledAt: null,
                        reconciliationState: "failed",
                        retentionExpiresAt: addMilliseconds(
                            updatedAt,
                            chatTerminalRetentionMilliseconds
                        ),
                        state: "unresolved",
                        stateVersion: run.stateVersion + 1,
                        terminalAt: updatedAt,
                        updatedAt,
                    })
                    .where(
                        and(
                            eq(chatRuns.id, run.id),
                            eq(chatRuns.stateVersion, run.stateVersion)
                        )
                    )
                    .returning()
                    .get();
                if (updated === undefined) throw new ChatRunTransitionError();
                appendRealtimeMarker(transaction, updatedAt);
                return toChatRunSummary(parseRun(updated));
            });
        },
        resolveLocalRunId(alias) {
            return read((transaction) => {
                const transcript = existingTranscriptGeneration(
                    transaction,
                    gatewayScope,
                    alias.sessionKey
                );
                if (transcript?.status !== "ready") return;
                const identities = [
                    eq(chatRuns.historyMessageId, alias.historyMessageId),
                    ...(alias.idempotencyKey === undefined
                        ? []
                        : [eq(chatRuns.idempotencyKey, alias.idempotencyKey)]),
                    ...(alias.providerRunId === undefined
                        ? []
                        : [eq(chatRuns.providerRunId, alias.providerRunId)]),
                ];
                const rows = transaction
                    .select({ id: chatRuns.id })
                    .from(chatRuns)
                    .where(
                        and(
                            eq(chatRuns.gatewayScope, gatewayScope),
                            eq(chatRuns.sessionKey, alias.sessionKey),
                            eq(
                                chatRuns.transcriptGeneration,
                                transcript.currentGeneration
                            ),
                            or(...identities)
                        )
                    )
                    .limit(2)
                    .all();
                return rows.length === 1 ? rows[0]!.id : undefined;
            });
        },
        requestCancellation(runId, sessionKey, at = toDate(nowMs())) {
            return write((transaction) => {
                const run = currentTranscriptRun(transaction, gatewayScope, runId);
                if (run === undefined || run.sessionKey !== sessionKey) {
                    throw new ChatRunNotFoundError();
                }
                if (
                    ["cancelled", "completed", "failed", "unresolved"].includes(run.state)
                ) {
                    return Object.freeze({
                        run: toChatRunSummary(run),
                        shouldDispatch: false,
                    });
                }
                if (run.cancelRequestedAt !== null) {
                    return Object.freeze({
                        run: toChatRunSummary(run),
                        shouldDispatch: run.state === "cancel-requested",
                    });
                }
                const appended = appendEventsInTransaction(transaction, run, [
                    {
                        kind: "cancel",
                        occurredAtMs: Math.max(getTime(run.updatedAt), getTime(at)),
                        source: "operator",
                    },
                ]);
                return Object.freeze({
                    run: appended.run,
                    shouldDispatch: true,
                });
            });
        },
    };
    return Object.freeze(repository);
}
