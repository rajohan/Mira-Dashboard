import * as v from "valibot";

import {
    chatAbortInputSchema,
    chatAbortOutputSchema,
    chatCompanionAskInputSchema,
    chatCompanionAskOutputSchema,
    chatCompanionResetInputSchema,
    chatCompanionResetOutputSchema,
    chatCompanionStateInputSchema,
    chatCompanionStateOutputSchema,
    chatHistoryInputSchema,
    chatMessageGetInputSchema,
    chatModelsListInputSchema,
    chatModelsListOutputSchema,
    chatRuntimeInputSchema,
    chatRuntimeOutputSchema,
    chatSendInputSchema,
    chatSendOutputSchema,
    chatSessionSettingsInputSchema,
    chatSessionSettingsOutputSchema,
    type ChatAbortInput,
    type ChatAbortOutput,
    type ChatCompanionAskInput,
    type ChatCompanionAskOutput,
    type ChatCompanionResetInput,
    type ChatCompanionResetOutput,
    type ChatCompanionStateInput,
    type ChatCompanionStateOutput,
    type ChatHistoryInput,
    type ChatHistoryOutput,
    type ChatMessageGetInput,
    type ChatMessageGetOutput,
    type ChatModelsListInput,
    type ChatModelsListOutput,
    type ChatRuntimeInput,
    type ChatRuntimeOutput,
    type ChatSendInput,
    type ChatSendOutput,
    type ChatSessionSettingsInput,
    type ChatSessionSettingsOutput,
} from "../../../contracts/chat.ts";
import {
    chatAttachmentTicketPrepareInputSchema,
    chatAttachmentTicketPrepareOutputSchema,
    type ChatAttachmentTicketPrepareInput,
    type ChatAttachmentTicketPrepareOutput,
} from "../../../contracts/chatMedia.ts";
import {
    chatExternalRunsPerProcessMaximum,
    chatExternalRunsPerSessionMaximum,
    chatExternalRunFitsBudget,
    chatExternalRunSchema,
    chatExternalStreamResetMaximum,
    chatHistoryProviderPageMaximum,
    chatHistoryResponseMaximumBytes,
    chatMessageTextMaximumCodeUnits,
    normalizeChatProviderUserIdentity,
    chatRunEventMaximum,
    chatRuntimeProjectionPartsMaximum,
    chatRuntimeResponseMaximumBytes,
    type ChatExternalRun,
    type ChatMessage,
    type ChatMessagePart,
    type ChatRuntimeProjectionPart,
} from "../../../contracts/chatModel.ts";
import { mergeChatStreamText } from "../../../shared/chatStreamText.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { type ChatCoalescerScheduler, ChatRuntimeEventCoalescer } from "./coalescer.ts";
import {
    ChatAdmissionCapacityError,
    ChatAdmissionConflictError,
    ChatProviderSequenceConflictError,
    ChatProviderSequenceGapError,
    ChatRunNotFoundError,
    ChatRunTransitionError,
    ChatTranscriptUnavailableError,
} from "./errors.ts";
import {
    ChatHistoryService,
    type ChatHistoryObservationPort,
    type ChatProviderObservationBoundary,
} from "./history.ts";
import {
    ChatAttachmentTicketError,
    type ChatAttachmentTicketConsumer,
    type ChatAttachmentTicketPreparer,
    type ChatAttachmentTicketReservation,
    type ChatProvider,
    ChatProviderCapacityError,
    ChatProviderConflictError,
    type ChatProviderEvent,
    type ChatProviderEventGap,
    type ChatProviderInFlightRun,
    ChatProviderNotFoundError,
    ChatProviderUnknownOutcomeError,
    ChatProviderUnavailableError,
    type ChatProviderReconciliationReason,
} from "./provider.ts";
import {
    type ChatAdmissionActor,
    type ChatExternalRuntimeSnapshotEntry,
    type ChatRepository,
    type ChatRuntimeEventDraft,
} from "./repository.ts";
import {
    chatSessionSubscriptionMaximum,
    ChatSessionSubscriptionManager,
    ChatSubscriptionCapacityError,
} from "./subscriptionManager.ts";
import type {
    ChatTranscriptGenerationChange,
    ChatTranscriptLifecycleCoordinator,
} from "./transcriptLifecycle.ts";

const reconciliationRetryMilliseconds = 1000;
const reconciliationRetryMaximumMilliseconds = 60_000;
const reconciliationLifecycleMilliseconds = 24 * 60 * 60 * 1000;
export const chatRetentionSweepBatchSize = 100;
export const chatRetentionSweepMaximumBatches = 4;
export const chatCompanionAskProcessMaximum = 6;
export const chatCompanionAskActorWindowMaximum = 4;
export const chatCompanionAskRateWindowMilliseconds = 60_000;
export const chatCompanionRateActorMaximum = 64;
/** Interrupted provider-only projections expire unless history refreshes them. */
export const chatExternalRunStaleMilliseconds = 15 * 60 * 1000;
const externalPendingAssistantAppendMaximumCodeUnits = 64 * 1024;
const externalHistoryUserAnchorLookbackMilliseconds = 5 * 60 * 1000;
type LocalChatAbortInput = Extract<ChatAbortInput, { readonly runId: string }>;
type ExternalChatAbortInput = Extract<ChatAbortInput, { readonly providerRunId: string }>;
type ExternalRuntimeResumeMetadata = Omit<ChatExternalRuntimeSnapshotEntry, "run">;

interface ChatCompanionAskAdmission {
    controller: AbortController;
    generation: number;
    promise: Promise<ChatCompanionAskOutput>;
    released: boolean;
}

interface ChatAbortOperation {
    readonly abortAttemptId?: string;
    readonly promise: Promise<ChatAbortOutput>;
}

export type ChatServiceErrorReason =
    | "capacity"
    | "conflict"
    | "invalid-input"
    | "not-found"
    | "provider-unavailable"
    | "unknown-outcome";

export class ChatServiceError extends Error {
    public readonly reason: ChatServiceErrorReason;

    public constructor(reason: ChatServiceErrorReason, options?: ErrorOptions) {
        super(`Chat operation failed: ${reason}`, options);
        this.name = "ChatServiceError";
        this.reason = reason;
    }
}

export interface ChatRecoveryScheduler {
    readonly clear: (handle: unknown) => void;
    readonly schedule: (callback: () => void, delayMs: number) => unknown;
}

const defaultRecoveryScheduler: ChatRecoveryScheduler = Object.freeze({
    clear(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    schedule(callback: () => void, delayMs: number) {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
    },
});

export interface ChatServiceOptions {
    readonly activeProviderRunIds?: (
        sessionKey: string,
        signal?: AbortSignal
    ) => Promise<readonly string[] | undefined>;
    readonly attachmentConsumer: ChatAttachmentTicketConsumer;
    readonly attachmentPreparer: ChatAttachmentTicketPreparer;
    readonly coalescerScheduler?: ChatCoalescerScheduler;
    readonly nowMs?: () => number;
    readonly onAsyncFailure?: (error: unknown) => void;
    readonly provider: ChatProvider;
    readonly recoveryScheduler?: ChatRecoveryScheduler;
    readonly repository: ChatRepository;
    readonly subscriptionIdleMilliseconds?: number;
    readonly subscriptionMaximum?: number;
    readonly transcriptLifecycle?: ChatTranscriptLifecycleCoordinator;
}

export interface ChatService {
    readonly abort: (
        input: ChatAbortInput,
        signal?: AbortSignal
    ) => Promise<ChatAbortOutput>;
    readonly companionAsk: (
        input: ChatCompanionAskInput,
        actor: ChatAdmissionActor,
        signal?: AbortSignal
    ) => Promise<ChatCompanionAskOutput>;
    readonly companionReset: (
        input: ChatCompanionResetInput,
        signal?: AbortSignal
    ) => Promise<ChatCompanionResetOutput>;
    readonly companionState: (
        input: ChatCompanionStateInput,
        signal?: AbortSignal
    ) => Promise<ChatCompanionStateOutput>;
    readonly dispose: () => Promise<void>;
    readonly getMessage: (
        input: ChatMessageGetInput,
        signal?: AbortSignal
    ) => Promise<ChatMessageGetOutput>;
    readonly history: (
        input: ChatHistoryInput,
        signal?: AbortSignal
    ) => Promise<ChatHistoryOutput>;
    readonly listModels: (
        input: ChatModelsListInput,
        signal?: AbortSignal
    ) => Promise<ChatModelsListOutput>;
    readonly observeProviderUserMessage: (
        message: Readonly<{
            attachments?: readonly Extract<ChatMessagePart, { kind: "attachment" }>[];
            messageId: string;
            providerRunIds: readonly string[];
            receivedAtMs: number;
            sessionKey: string;
            text: string;
        }>
    ) => Promise<void>;
    readonly prepareAttachmentTicket: (
        input: ChatAttachmentTicketPrepareInput,
        actorId: string,
        signal?: AbortSignal
    ) => Promise<ChatAttachmentTicketPrepareOutput>;
    readonly reconcileProviderSessionActivity: (
        sessionKey: string,
        signal?: AbortSignal
    ) => Promise<void>;
    readonly recover: (signal?: AbortSignal) => Promise<void>;
    readonly runtime: (
        input: ChatRuntimeInput,
        signal?: AbortSignal
    ) => Promise<ChatRuntimeOutput>;
    readonly send: (
        input: ChatSendInput,
        actor: ChatAdmissionActor,
        signal?: AbortSignal
    ) => Promise<ChatSendOutput>;
    readonly sweepSubscriptions: (atMs?: number) => Promise<number>;
    readonly sweepRetention: (at?: Date) => Promise<number>;
    readonly updateSessionSettings: (
        input: ChatSessionSettingsInput,
        signal?: AbortSignal
    ) => Promise<ChatSessionSettingsOutput>;
}

function providerEventRunId(event: ChatProviderEvent): string {
    return event.providerRunId;
}

type ChatProviderRuntimeEvent = Exclude<ChatProviderEvent, { kind: "user" }>;

function providerEventDraft(event: ChatProviderRuntimeEvent): ChatRuntimeEventDraft {
    switch (event.kind) {
        case "compaction": {
            return {
                kind: "provider-noop",
                occurredAtMs: event.receivedAtMs,
                providerSequenceEnd: event.providerSequence,
                providerSequenceStart: event.providerSequence,
                reason: "ignored",
            };
        }
        case "delta": {
            return {
                kind: event.stream,
                mode: event.mode,
                occurredAtMs: event.receivedAtMs,
                providerSequenceEnd: event.providerSequence,
                providerSequenceStart: event.providerSequence,
                text: event.text,
            };
        }
        case "tool": {
            return {
                callId: event.callId,
                ...(event.callIdSource === undefined
                    ? {}
                    : { callIdSource: event.callIdSource }),
                ...(event.input === undefined ? {} : { input: event.input }),
                isError: event.isError,
                kind: "tool",
                name: event.name,
                ...(event.nameSource === undefined
                    ? {}
                    : { nameSource: event.nameSource }),
                occurredAtMs: event.receivedAtMs,
                ...(event.output === undefined ? {} : { output: event.output }),
                phase: event.phase,
                providerSequence: event.providerSequence,
            };
        }
        case "item": {
            return {
                itemId: event.itemId,
                itemType: event.itemType,
                kind: "item",
                occurredAtMs: event.receivedAtMs,
                providerSequence: event.providerSequence,
                ...(event.text === undefined ? {} : { text: event.text }),
            };
        }
        case "status": {
            return {
                kind: "status",
                occurredAtMs: event.receivedAtMs,
                phase: event.phase,
                providerSequence: event.providerSequence,
            };
        }
        case "plan": {
            return {
                ...(event.explanation === undefined
                    ? {}
                    : { explanation: event.explanation }),
                kind: "plan",
                occurredAtMs: event.receivedAtMs,
                phase: "update",
                providerSequence: event.providerSequence,
                steps: [...event.steps],
            };
        }
        case "terminal": {
            return {
                ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
                ...(event.errorMessage === undefined
                    ? {}
                    : { errorMessage: event.errorMessage }),
                kind: "terminal",
                occurredAtMs: event.receivedAtMs,
                outcome: event.outcome,
                providerRunId: event.providerRunId,
                providerSequence: event.providerSequence,
                ...(event.stopReason === undefined
                    ? {}
                    : { stopReason: event.stopReason }),
            };
        }
        case "noop": {
            return {
                kind: "provider-noop",
                occurredAtMs: event.receivedAtMs,
                providerSequenceEnd: event.providerSequence,
                providerSequenceStart: event.providerSequence,
                reason: "ignored",
            };
        }
    }
}

function terminalState(state: string): boolean {
    return (
        state === "cancelled" ||
        state === "completed" ||
        state === "failed" ||
        state === "unresolved"
    );
}

function messageMatchesRun(
    message: ChatMessage,
    localRunId: string,
    providerRunId: string | undefined,
    idempotencyKey: string
): boolean {
    return (
        message.role === "assistant" &&
        (message.localRunId === localRunId ||
            message.idempotencyKey === idempotencyKey ||
            (providerRunId !== undefined && message.runId === providerRunId) ||
            message.runId === idempotencyKey)
    );
}

function messageHasFinalText(message: ChatMessage): boolean {
    return (
        message.role === "assistant" &&
        message.content.kind === "complete" &&
        message.content.parts.some((part) => part.kind === "text" && part.text.length > 0)
    );
}

function findFinalHistoryMessage(
    messages: readonly ChatMessage[],
    localRunId: string,
    providerRunId: string | undefined,
    idempotencyKey: string
): ChatMessage | undefined {
    let directlyMatchedFinal: ChatMessage | undefined;
    for (const message of messages) {
        if (
            messageHasFinalText(message) &&
            messageMatchesRun(message, localRunId, providerRunId, idempotencyKey)
        ) {
            directlyMatchedFinal = message;
        }
    }
    if (directlyMatchedFinal !== undefined) return directlyMatchedFinal;

    const admissionIndex = messages.findIndex(
        (message) => message.role === "user" && message.idempotencyKey === idempotencyKey
    );
    if (admissionIndex === -1) return undefined;

    let causalFinal: ChatMessage | undefined;
    for (let index = admissionIndex + 1; index < messages.length; index += 1) {
        const message = messages[index]!;
        if (message.role === "user") break;
        if (messageHasFinalText(message)) causalFinal = message;
    }
    return causalFinal;
}

function compareExternalRuns(left: ChatExternalRun, right: ChatExternalRun): number {
    return (
        left.updatedAtMs - right.updatedAtMs ||
        left.sessionKey.localeCompare(right.sessionKey) ||
        left.providerRunId.localeCompare(right.providerRunId)
    );
}

interface ActiveProviderRun {
    readonly providerRunId: string;
    readonly updatedAtMs: number;
}

function externalAbortBoundaryFields(
    run: ChatExternalRun | undefined
): Readonly<{ abortBoundary?: ChatExternalRun["abortBoundary"] }> {
    return run?.abortBoundary === undefined ? {} : { abortBoundary: run.abortBoundary };
}

function externalObservationIsStrictlyNewer(
    run: ChatExternalRun,
    observation: ChatProviderObservationBoundary
): boolean {
    return (
        observation.epoch > run.observationEpoch &&
        observation.observedAtMs >= run.observedAtMs
    );
}

function externalObservationIsCurrentOrNewer(
    run: ChatExternalRun,
    observation: ChatProviderObservationBoundary
): boolean {
    return (
        observation.epoch >= run.observationEpoch &&
        observation.observedAtMs >= run.observedAtMs
    );
}

function externalRunRemainsInFlightAtObservation(
    run: ChatExternalRun,
    observation: ChatProviderObservationBoundary
): boolean {
    // ChatHistoryService observes the first-page in-flight snapshot before the
    // page messages on the same boundary. An assistant row on that boundary can
    // therefore be a partial echo, not authoritative completion.
    return (
        run.lifecycle === "active" &&
        run.observationEpoch === observation.epoch &&
        run.observedAtMs === observation.observedAtMs
    );
}

function externalLiveObservationIsNewer(
    run: ChatExternalRun,
    observation: ChatProviderObservationBoundary
): boolean {
    return (
        observation.epoch > run.observationEpoch &&
        observation.observedAtMs >= run.observedAtMs
    );
}

function compactExternalRun(run: ChatExternalRun): ChatExternalRun {
    if (
        run.text.length === 0 &&
        run.plan === undefined &&
        (run.parts?.length ?? 0) === 0
    ) {
        return run;
    }
    return v.parse(chatExternalRunSchema, {
        ...externalAbortBoundaryFields(run),
        continuity: run.continuity,
        hasUnprojectedActivity: true,
        lifecycle: run.lifecycle,
        observationEpoch: run.observationEpoch,
        observedAtMs: run.observedAtMs,
        projectionTruncated: true,
        providerRunId: run.providerRunId,
        sessionKey: run.sessionKey,
        source: run.source,
        ...(run.streamResets === undefined ? {} : { streamResets: run.streamResets }),
        text: "",
        updatedAtMs: run.updatedAtMs,
    });
}

function safeCodeUnitPrefix(text: string, requestedLength: number): string {
    let length = Math.min(requestedLength, text.length);
    if (length <= 0 || length >= text.length) return text.slice(0, length);
    if ((text.codePointAt(length - 1) ?? 0) > 65_535) length -= 1;
    return text.slice(0, length);
}

function boundExternalRunProjection(run: ChatExternalRun): ChatExternalRun {
    if (chatExternalRunFitsBudget(run)) return v.parse(chatExternalRunSchema, run);
    const compact: ChatExternalRun = {
        ...run,
        hasUnprojectedActivity: true,
        parts: [],
        projectionTruncated: true,
    };
    if (chatExternalRunFitsBudget(compact)) {
        return v.parse(chatExternalRunSchema, compact);
    }

    let base: ChatExternalRun = { ...compact, text: "" };
    if (!chatExternalRunFitsBudget(base) && base.plan !== undefined) {
        const { plan: _omittedPlan, ...withoutPlan } = base;
        base = withoutPlan;
    }
    if (!chatExternalRunFitsBudget(base)) {
        const fallback: ChatExternalRun = {
            ...externalAbortBoundaryFields(run),
            continuity: run.continuity,
            hasUnprojectedActivity: true,
            lifecycle: run.lifecycle,
            observationEpoch: run.observationEpoch,
            observedAtMs: run.observedAtMs,
            projectionTruncated: true,
            providerRunId: run.providerRunId,
            sessionKey: run.sessionKey,
            source: run.source,
            ...(run.streamResets === undefined ? {} : { streamResets: run.streamResets }),
            text: "",
            updatedAtMs: run.updatedAtMs,
        };
        if (!chatExternalRunFitsBudget(fallback)) {
            throw new Error("External chat projection identifiers exceed the budget");
        }
        return v.parse(chatExternalRunSchema, fallback);
    }
    let lower = 1;
    let upper = compact.text.length;
    let best = base;
    while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2);
        const candidate: ChatExternalRun = {
            ...base,
            text: safeCodeUnitPrefix(compact.text, middle),
        };
        if (chatExternalRunFitsBudget(candidate)) {
            best = candidate;
            lower = middle + 1;
        } else {
            upper = middle - 1;
        }
    }
    return v.parse(chatExternalRunSchema, best);
}

function externalStreamResetsAfterEvent(
    previous: ChatExternalRun | undefined,
    event: ChatProviderEvent
): ChatExternalRun["streamResets"] {
    const current = previous?.streamResets ?? [];
    if (
        event.kind !== "delta" ||
        event.mode !== "replace" ||
        event.streamId === undefined
    ) {
        return current.length === 0 ? undefined : current;
    }
    const next = {
        resetId: `${event.providerRunId}:${event.providerSequence}`,
        streamId: event.streamId,
    };
    return [...current.filter(({ streamId }) => streamId !== next.streamId), next].slice(
        -chatExternalStreamResetMaximum
    );
}

/**
 * Reindexes a bounded external projection before contract validation.
 * Part-count overflow loses detail; sequence-only rollover preserves every part.
 * @param parts Ordered external projection parts before contract validation.
 * @returns Bounded parts plus whether projection detail was discarded.
 */
export function normalizeExternalProjectionParts(
    parts: readonly ChatRuntimeProjectionPart[]
): Readonly<{
    parts: readonly ChatRuntimeProjectionPart[];
    partsExceeded: boolean;
}> {
    const partsExceeded = parts.length > chatRuntimeProjectionPartsMaximum;
    const sequenceExceeded = (parts.at(-1)?.sequence ?? 0) > chatRunEventMaximum;
    if (!partsExceeded && !sequenceExceeded) return { parts, partsExceeded };
    const selected = partsExceeded
        ? parts.slice(-chatRuntimeProjectionPartsMaximum)
        : parts;
    return {
        parts: selected.map((part, index) => ({ ...part, sequence: index + 1 })),
        partsExceeded,
    };
}

function mergeExternalInFlightParts(
    previous: ChatExternalRun | undefined,
    providerRunId: string,
    text: string,
    observedAtMs: number
): Readonly<{
    parts: readonly ChatRuntimeProjectionPart[];
    projectionTruncated: boolean;
}> {
    const baselineIdentity = {
        segmentId: `${providerRunId}:history-assistant`,
        streamId: "assistant",
    } as const;
    const parts: readonly ChatRuntimeProjectionPart[] =
        previous?.parts ??
        (previous?.text === undefined || previous.text === ""
            ? []
            : [
                  {
                      kind: "assistant",
                      ...baselineIdentity,
                      occurredAtMs: observedAtMs,
                      sequence: 1,
                      text: previous.text,
                  },
              ]);
    const wasProjectionTruncated = previous?.projectionTruncated ?? false;

    const renderedText = parts
        .filter((part) => part.kind === "assistant")
        .map(({ text: partText }) => partText)
        .join("");
    if (renderedText === text) {
        return { parts, projectionTruncated: wasProjectionTruncated };
    }

    const lastAssistantIndex = parts.findLastIndex((part) => part.kind === "assistant");
    let merged: readonly ChatRuntimeProjectionPart[];
    if (text === "") {
        merged = parts.filter((part) => part.kind !== "assistant");
    } else if (lastAssistantIndex === -1) {
        merged = [
            ...parts,
            {
                kind: "assistant",
                ...baselineIdentity,
                sequence: (parts.at(-1)?.sequence ?? 0) + 1,
                text,
            },
        ];
    } else if (text.startsWith(renderedText)) {
        const suffix = text.slice(renderedText.length);
        merged = parts.map((part, index) =>
            index === lastAssistantIndex && part.kind === "assistant"
                ? { ...part, text: part.text + suffix }
                : part
        );
    } else {
        merged = parts
            .filter(
                (part, index) => part.kind !== "assistant" || index === lastAssistantIndex
            )
            .map((part) => (part.kind === "assistant" ? { ...part, text } : part));
    }
    const normalized = normalizeExternalProjectionParts(merged);
    return {
        parts: normalized.parts,
        projectionTruncated: wasProjectionTruncated || normalized.partsExceeded,
    };
}

function historyUserText(message: ChatMessage): string | undefined {
    if (message.role !== "user" || message.content.kind !== "complete") return;
    const text = message.content.parts
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .join("");
    return text === "" ? undefined : text;
}

function externalHistoryUserCandidates(
    run: ChatExternalRun,
    messages: readonly ChatMessage[],
    activeExternalRunCount: number
): readonly ChatMessage[] {
    const exact = messages.filter(
        (message) => message.role === "user" && message.runId === run.providerRunId
    );
    if (exact.length > 0 || activeExternalRunCount !== 1) return exact;

    const activityTimes = [
        run.observedAtMs,
        run.updatedAtMs,
        ...(run.parts ?? []).flatMap(({ occurredAtMs }) =>
            occurredAtMs === undefined ? [] : [occurredAtMs]
        ),
    ];
    const earliestActivityAtMs = Math.min(...activityTimes);
    const latestActivityAtMs = Math.max(...activityTimes);
    const unscoped = messages.filter(
        (message) =>
            message.role === "user" &&
            message.runId === undefined &&
            message.createdAtMs !== undefined
    );
    const nearestPreceding = unscoped
        .filter(
            ({ createdAtMs }) =>
                createdAtMs !== undefined &&
                createdAtMs <= earliestActivityAtMs &&
                createdAtMs >=
                    earliestActivityAtMs - externalHistoryUserAnchorLookbackMilliseconds
        )
        .toSorted(
            (left, right) =>
                (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0) ||
                (right.sequence ?? 0) - (left.sequence ?? 0)
        )[0];
    const selected = [
        ...(nearestPreceding === undefined ? [] : [nearestPreceding]),
        ...unscoped.filter(
            ({ createdAtMs }) =>
                createdAtMs !== undefined &&
                createdAtMs >= earliestActivityAtMs &&
                createdAtMs <= latestActivityAtMs
        ),
    ];
    return [
        ...new Map(selected.map((message) => [message.id, message] as const)).values(),
    ];
}

function mergeExternalHistoryUserAnchors(
    run: ChatExternalRun,
    messages: readonly ChatMessage[]
): Readonly<{
    changed: boolean;
    parts: readonly ChatRuntimeProjectionPart[];
    projectionTruncated: boolean;
}> {
    const originalParts: readonly ChatRuntimeProjectionPart[] =
        run.parts ??
        (run.text === ""
            ? []
            : [
                  {
                      kind: "assistant",
                      occurredAtMs: run.observedAtMs,
                      segmentId: `${run.providerRunId}:history-assistant`,
                      sequence: 1,
                      streamId: "assistant",
                      text: run.text,
                  },
              ]);
    const canonicalUsers = messages.flatMap((message) => {
        const text = historyUserText(message);
        if (text === undefined || message.createdAtMs === undefined) return [];
        return [
            {
                identity:
                    normalizeChatProviderUserIdentity(message.idempotencyKey) ??
                    message.idempotencyKey ??
                    normalizeChatProviderUserIdentity(message.id) ??
                    message.id,
                identities: [message.id, message.idempotencyKey].filter(
                    (identity): identity is string => identity !== undefined
                ),
                message,
                text,
            },
        ];
    });
    const canonicalUserByIdentity = new Map(
        canonicalUsers.flatMap((user) =>
            user.identities.map((identity) => [identity, user] as const)
        )
    );
    let normalizedExistingIdentity = false;
    const seenUserIdentities = new Set<string>();
    const parts = originalParts.flatMap((part) => {
        if (part.kind !== "user" || part.messageId === undefined) return [part];
        const canonical = canonicalUserByIdentity.get(part.messageId);
        const identity =
            canonical?.identity ??
            normalizeChatProviderUserIdentity(part.messageId) ??
            part.messageId;
        if (seenUserIdentities.has(identity)) {
            normalizedExistingIdentity = true;
            return [];
        }
        seenUserIdentities.add(identity);
        if (canonical === undefined || identity === part.messageId) return [part];
        normalizedExistingIdentity = true;
        return [
            {
                ...part,
                messageId: identity,
                occurredAtMs: canonical.message.createdAtMs,
                text: canonical.text,
            },
        ];
    });
    const existingMessageIds = new Set(
        parts.flatMap((part) =>
            part.kind === "user" && part.messageId !== undefined ? [part.messageId] : []
        )
    );
    const anchors = canonicalUsers.flatMap((canonical, historyIndex) => {
        if (existingMessageIds.has(canonical.identity)) return [];
        existingMessageIds.add(canonical.identity);
        return [
            {
                historyIndex,
                part: {
                    kind: "user" as const,
                    messageId: canonical.identity,
                    occurredAtMs: canonical.message.createdAtMs,
                    sequence: 1,
                    text: canonical.text,
                },
                providerOrder: canonical.message.sequence ?? Number.MAX_SAFE_INTEGER,
            },
        ];
    });
    if (anchors.length === 0 && !normalizedExistingIdentity) {
        return {
            changed: false,
            parts,
            projectionTruncated: run.projectionTruncated,
        };
    }
    const decorated = [
        ...parts.map((part, index) => ({
            historyIndex: index,
            part,
            providerOrder: part.sequence,
        })),
        ...anchors,
    ].toSorted((left, right) => {
        const leftAt = left.part.occurredAtMs ?? run.observedAtMs;
        const rightAt = right.part.occurredAtMs ?? run.observedAtMs;
        const userKindOrder =
            Number(right.part.kind === "user") - Number(left.part.kind === "user");
        return (
            leftAt - rightAt ||
            left.providerOrder - right.providerOrder ||
            userKindOrder ||
            left.historyIndex - right.historyIndex
        );
    });
    const normalized = normalizeExternalProjectionParts(
        decorated.map(({ part }, index) => ({ ...part, sequence: index + 1 }))
    );
    return {
        changed: true,
        parts: normalized.parts,
        projectionTruncated: run.projectionTruncated || normalized.partsExceeded,
    };
}

function historyConfirmsExternalTerminal(
    run: ChatExternalRun,
    messages: readonly ChatMessage[],
    externalRunCount: number
): boolean {
    const userCandidates = externalHistoryUserCandidates(run, messages, externalRunCount);
    if (userCandidates.length === 0) return false;
    const candidateIds = new Set(userCandidates.map(({ id }) => id));
    let anchored = false;
    for (const message of messages) {
        if (message.role === "user" && candidateIds.has(message.id)) {
            anchored = true;
            continue;
        }
        if (anchored && message.role === "assistant") return true;
    }
    return false;
}

function updateExternalStreamPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatProviderEvent, { kind: "delta" }>
): readonly ChatRuntimeProjectionPart[] {
    const kind = event.stream;
    const matchesStream = (
        part: ChatRuntimeProjectionPart
    ): part is Extract<ChatRuntimeProjectionPart, { kind: typeof kind }> =>
        part.kind === kind &&
        (event.streamId === undefined
            ? part.streamId === undefined
            : part.streamId === event.streamId);
    const streamIdentity =
        event.streamId === undefined && event.segmentId === undefined
            ? {}
            : {
                  segmentId:
                      event.segmentId ??
                      `${event.providerRunId}:${event.providerSequence}`,
                  ...(event.streamId === undefined ? {} : { streamId: event.streamId }),
              };

    if (event.segmentId !== undefined) {
        const segmentIndex = parts.findIndex(
            (part) => part.kind === kind && part.segmentId === event.segmentId
        );
        if (segmentIndex !== -1) {
            const segment = parts[segmentIndex];
            if (segment?.kind !== kind) return parts;
            let text = event.text;
            if (event.mode === "append") text = segment.text + event.text;
            if (event.mode === "merge") {
                text = mergeChatStreamText(segment.text, event.text);
            }
            return parts.map((part, index) =>
                index === segmentIndex
                    ? {
                          ...segment,
                          ...(event.streamId === undefined
                              ? {}
                              : { streamId: event.streamId }),
                          text,
                      }
                    : part
            );
        }
        if (event.text === "") return parts;
        return [
            ...parts,
            {
                kind,
                ...streamIdentity,
                occurredAtMs: event.receivedAtMs,
                sequence: (parts.at(-1)?.sequence ?? 0) + 1,
                text: event.text,
            },
        ];
    }

    const appendAtProviderPosition = (
        base: readonly ChatRuntimeProjectionPart[],
        text: string
    ) => {
        if (text === "") return base;
        const previous = base.at(-1);
        if (previous === undefined || !matchesStream(previous)) {
            return [
                ...base,
                {
                    kind,
                    ...streamIdentity,
                    occurredAtMs: event.receivedAtMs,
                    sequence: (previous?.sequence ?? 0) + 1,
                    text,
                },
            ];
        }
        return [
            ...base.slice(0, -1),
            {
                kind,
                occurredAtMs: previous.occurredAtMs,
                ...(previous.segmentId === undefined
                    ? streamIdentity
                    : {
                          segmentId: previous.segmentId,
                          ...(previous.streamId === undefined
                              ? {}
                              : { streamId: previous.streamId }),
                      }),
                sequence: previous.sequence,
                text: previous.text + text,
            },
        ];
    };
    if (event.mode === "append") {
        return appendAtProviderPosition(parts, event.text);
    }
    if (event.mode === "merge") {
        const renderedText = parts
            .filter((part) => matchesStream(part))
            .map(({ text }) => text)
            .join("");
        const mergedText = mergeChatStreamText(renderedText, event.text);
        const suffix = mergedText.startsWith(renderedText)
            ? mergedText.slice(renderedText.length)
            : event.text;
        return appendAtProviderPosition(parts, suffix);
    }
    const withoutReplacedStream = parts.filter((part) => !matchesStream(part));
    return appendAtProviderPosition(withoutReplacedStream, event.text);
}

function updateExternalToolPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatProviderEvent, { kind: "tool" }>
): readonly ChatRuntimeProjectionPart[] {
    const index = parts.findIndex(
        (part) => part.kind === "tool" && part.callId === event.callId
    );
    const previous = index === -1 ? undefined : parts[index];
    const previousTool = previous?.kind === "tool" ? previous : undefined;
    const previousIsTerminal =
        previousTool !== undefined &&
        (previousTool.phase === "succeeded" || previousTool.phase === "failed");
    const terminal =
        previousIsTerminal && event.phase !== "succeeded" && event.phase !== "failed"
            ? previousTool
            : undefined;
    const projection: ChatRuntimeProjectionPart = {
        callId: event.callId,
        ...((previousTool?.callIdSource ?? event.callIdSource) === undefined
            ? {}
            : { callIdSource: "synthetic" }),
        ...((previousTool?.input ?? event.input) === undefined
            ? {}
            : { input: previousTool?.input ?? event.input }),
        isError: terminal?.isError ?? event.isError,
        kind: "tool",
        name: previousTool?.name ?? event.name,
        ...((previousTool?.nameSource ?? event.nameSource) === undefined
            ? {}
            : { nameSource: "synthetic" }),
        ...((event.output ?? previousTool?.output) === undefined
            ? {}
            : { output: event.output ?? previousTool?.output }),
        phase: terminal?.phase ?? event.phase,
        occurredAtMs: previousTool?.occurredAtMs ?? event.receivedAtMs,
        sequence: previousTool?.sequence ?? (parts.at(-1)?.sequence ?? 0) + 1,
    };
    if (index === -1) return [...parts, projection];
    return parts.map((part, partIndex) => (partIndex === index ? projection : part));
}

function updateExternalItemPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatProviderEvent, { kind: "item" }>,
    occurredAtMs?: number
): readonly ChatRuntimeProjectionPart[] {
    const index = parts.findIndex(
        (part) => part.kind === "item" && part.id === event.itemId
    );
    const previous = index === -1 ? undefined : parts[index];
    const previousItem = previous?.kind === "item" ? previous : undefined;
    const text = event.text ?? previousItem?.text;
    const projection: ChatRuntimeProjectionPart = {
        id: event.itemId,
        kind: "item",
        ...((previousItem?.occurredAtMs ?? occurredAtMs) === undefined
            ? {}
            : { occurredAtMs: previousItem?.occurredAtMs ?? occurredAtMs }),
        sequence: previousItem?.sequence ?? (parts.at(-1)?.sequence ?? 0) + 1,
        ...(text === undefined ? {} : { text }),
        type: previousItem?.type ?? event.itemType,
    };
    if (index === -1) return [...parts, projection];
    return parts.map((part, partIndex) => (partIndex === index ? projection : part));
}

function updateExternalCompactionPart(
    parts: readonly ChatRuntimeProjectionPart[],
    event: Extract<ChatProviderEvent, { kind: "compaction" }>
): readonly ChatRuntimeProjectionPart[] {
    const itemId = `compaction:${event.providerRunId}`;
    if (event.phase === "inactive") {
        return parts.filter((part) => part.kind !== "item" || part.id !== itemId);
    }
    return updateExternalItemPart(
        parts,
        {
            ...event,
            itemId,
            itemType: "compaction",
            kind: "item",
            text: event.phase === "active" ? "Compacting context" : "Context compacted",
        },
        event.receivedAtMs
    );
}

function runtimeWithExternalRuns(
    durable: ChatRuntimeOutput,
    externalRuns: readonly ChatExternalRun[],
    externalRunsTruncated: boolean
): ChatRuntimeOutput {
    return {
        ...durable,
        externalRuns: [...externalRuns],
        externalRunsTruncated,
    };
}

function runtimeWithExternalRunsFits(
    durable: ChatRuntimeOutput,
    externalRuns: readonly ChatExternalRun[],
    externalRunsTruncated: boolean
): boolean {
    return (
        utf8ByteLength(
            JSON.stringify(
                runtimeWithExternalRuns(durable, externalRuns, externalRunsTruncated)
            )
        ) <= chatRuntimeResponseMaximumBytes
    );
}

/**
 * Preserves every bounded external identity and spends remaining bytes newest-first.
 * @param durable Durable local runtime response.
 * @param runs Provider-origin runtime projections.
 * @param externalRunsTruncated Whether provider-origin activity was omitted.
 * @returns The validated identity-preserving combined runtime response.
 */
function budgetExternalRuns(
    durable: ChatRuntimeOutput,
    runs: readonly ChatExternalRun[],
    externalRunsTruncated: boolean
): ChatRuntimeOutput {
    let selected = runs
        .map((run) => compactExternalRun(run))
        .toSorted(compareExternalRuns);
    if (!runtimeWithExternalRunsFits(durable, selected, externalRunsTruncated)) {
        throw new ChatServiceError("capacity", {
            cause: new RangeError(
                "External chat run identities exceed the runtime response budget"
            ),
        });
    }
    for (const full of runs.toSorted(compareExternalRuns).toReversed()) {
        const index = selected.findIndex(
            ({ providerRunId }) => providerRunId === full.providerRunId
        );
        if (index === -1) continue;
        const fullCandidate = selected.with(index, full);
        if (runtimeWithExternalRunsFits(durable, fullCandidate, externalRunsTruncated)) {
            selected = fullCandidate;
            continue;
        }

        let lower = 0;
        let upper = full.text.length;
        let best = selected[index]!;
        while (lower <= upper) {
            const middle = Math.floor((lower + upper) / 2);
            const candidateRun = v.parse(chatExternalRunSchema, {
                ...externalAbortBoundaryFields(full),
                continuity: full.continuity,
                hasUnprojectedActivity: true,
                lifecycle: full.lifecycle,
                observationEpoch: full.observationEpoch,
                observedAtMs: full.observedAtMs,
                projectionTruncated: true,
                providerRunId: full.providerRunId,
                sessionKey: full.sessionKey,
                source: full.source,
                ...(full.streamResets === undefined
                    ? {}
                    : { streamResets: full.streamResets }),
                text: safeCodeUnitPrefix(full.text, middle),
                updatedAtMs: full.updatedAtMs,
            });
            if (
                runtimeWithExternalRunsFits(
                    durable,
                    selected.with(index, candidateRun),
                    externalRunsTruncated
                )
            ) {
                best = candidateRun;
                lower = middle + 1;
            } else {
                upper = middle - 1;
            }
        }
        selected = selected.with(index, best);
        if (full.plan !== undefined) {
            const withPlan = v.parse(chatExternalRunSchema, {
                ...best,
                plan: full.plan,
            });
            if (
                runtimeWithExternalRunsFits(
                    durable,
                    selected.with(index, withPlan),
                    externalRunsTruncated
                )
            ) {
                selected = selected.with(index, withPlan);
            }
        }
    }
    return v.parse(
        chatRuntimeOutputSchema,
        runtimeWithExternalRuns(durable, selected, externalRunsTruncated)
    );
}

class ChatServiceImplementation implements ChatService, ChatHistoryObservationPort {
    readonly #activeProviderRunIds:
        | ((
              sessionKey: string,
              signal?: AbortSignal
          ) => Promise<readonly string[] | undefined>)
        | undefined;
    readonly #abortAcknowledgedRuns = new Set<string>();
    readonly #abortOperations = new Map<string, ChatAbortOperation>();
    readonly #attachmentConsumer: ChatAttachmentTicketConsumer;
    readonly #attachmentPreparer: ChatAttachmentTicketPreparer;
    readonly #backgroundWatchedSessions = new Set<string>();
    readonly #blockedRuns = new Set<string>();
    readonly #coalescers = new Map<string, ChatRuntimeEventCoalescer>();
    readonly #coalescerScheduler: ChatCoalescerScheduler | undefined;
    readonly #companionAsks = new Map<string, ChatCompanionAskAdmission>();
    readonly #companionGenerations = new Map<string, number>();
    readonly #companionRateWindows = new Map<string, number[]>();
    readonly #companionResets = new Map<string, Promise<ChatCompanionResetOutput>>();
    readonly #externalRuns = new Map<string, Map<string, ChatExternalRun>>();
    readonly #externalCoalescers = new Map<string, ChatRuntimeEventCoalescer>();
    readonly #externalCapacityReductionSessions = new Set<string>();
    readonly #externalDirtySessions = new Set<string>();
    readonly #externalObservationKinds = new Map<
        string,
        Map<string, ExternalRuntimeResumeMetadata>
    >();
    readonly #externalTruncatedSessions = new Set<string>();
    readonly #historyService: ChatHistoryService;
    readonly #nowMs: () => number;
    readonly #onAsyncFailure: (error: unknown) => void;
    readonly #provider: ChatProvider;
    readonly #pendingReservations = new Map<
        string,
        Readonly<{
            reservation: ChatAttachmentTicketReservation;
            settlement: "commit" | "hold" | "release";
        }>
    >();
    readonly #reconciliationAttempts = new Map<string, number>();
    readonly #reconciliationInFlight = new Map<string, Promise<boolean>>();
    readonly #reconciliationTimers = new Map<string, unknown>();
    readonly #recoveryScheduler: ChatRecoveryScheduler;
    readonly #repository: ChatRepository;
    readonly #subscriptions: ChatSessionSubscriptionManager;
    readonly #subscriptionMaximum: number;
    readonly #transcriptLifecycle: ChatTranscriptLifecycleCoordinator | undefined;
    readonly #unsubscribeTranscriptLifecycle: (() => void) | undefined;
    #companionAskCount = 0;
    #disposed = false;
    #externalObservationEpoch = 0;

    public constructor(options: ChatServiceOptions) {
        this.#activeProviderRunIds = options.activeProviderRunIds;
        this.#attachmentConsumer = options.attachmentConsumer;
        this.#attachmentPreparer = options.attachmentPreparer;
        this.#coalescerScheduler = options.coalescerScheduler;
        this.#nowMs = options.nowMs ?? Date.now;
        this.#onAsyncFailure = options.onAsyncFailure ?? (() => {});
        this.#provider = options.provider;
        this.#recoveryScheduler = options.recoveryScheduler ?? defaultRecoveryScheduler;
        this.#repository = options.repository;
        this.#transcriptLifecycle = options.transcriptLifecycle;
        this.#subscriptionMaximum =
            options.subscriptionMaximum ?? chatSessionSubscriptionMaximum;
        this.#historyService = new ChatHistoryService(
            options.provider,
            options.repository,
            this
        );
        this.#subscriptions = new ChatSessionSubscriptionManager({
            ...(options.subscriptionIdleMilliseconds === undefined
                ? {}
                : { idleMilliseconds: options.subscriptionIdleMilliseconds }),
            isPinned: (sessionKey) => {
                // Known chats retain a bounded backend-owned listener even without
                // a browser. Active local or provider-origin work independently
                // pins its durable resume watermark until history retires it.
                return (
                    this.#backgroundWatchedSessions.has(sessionKey) ||
                    this.#hasRuntimeSubscriptionPin(sessionKey)
                );
            },
            ...(options.subscriptionMaximum === undefined
                ? {}
                : { maximum: options.subscriptionMaximum }),
            nowMs: this.#nowMs,
            onEvent: (event) =>
                this.#handleProviderEvent(
                    event,
                    this.#beginExternalObservation(event.receivedAtMs)
                ),
            onGap: (gap) =>
                this.#handleProviderGap(
                    gap,
                    this.#beginExternalObservation(this.#nowMs())
                ),
            onReconciliationRequired: (sessionKey, reason) =>
                this.#handleSessionReconciliation(
                    sessionKey,
                    reason,
                    this.#beginExternalObservation(this.#nowMs())
                ),
            provider: options.provider,
            watermarks: (sessionKey) =>
                this.#repository.listProviderRunWatermarks(sessionKey),
        });
        this.#unsubscribeTranscriptLifecycle = options.transcriptLifecycle?.subscribe(
            (change) => this.#handleTranscriptGenerationChange(change)
        );
        this.#hydrateExternalRuntimeSnapshots();
    }

    #hydrateExternalRuntimeSnapshots(): void {
        this.#externalObservationEpoch =
            this.#repository.readExternalRuntimeObservationEpoch();
        const snapshots = this.#repository.listExternalRuntimeSnapshots();
        const persistedProviderRunIds = new Map<string, Set<string>>();
        for (const snapshot of snapshots) {
            persistedProviderRunIds.set(
                snapshot.sessionKey,
                new Set(snapshot.payload.entries.map(({ run }) => run.providerRunId))
            );
            if (snapshot.payload.truncated) {
                this.#externalTruncatedSessions.add(snapshot.sessionKey);
            }
            for (const entry of snapshot.payload.entries) {
                this.#externalObservationEpoch = Math.max(
                    this.#externalObservationEpoch,
                    entry.run.observationEpoch,
                    entry.run.abortBoundary?.baselineObservationEpoch ?? 0
                );
                this.#storeExternalRun(entry.run);
                let metadata = this.#externalObservationKinds.get(snapshot.sessionKey);
                if (metadata === undefined) {
                    metadata = new Map();
                    this.#externalObservationKinds.set(snapshot.sessionKey, metadata);
                }
                const { run: _run, ...resume } = entry;
                metadata.set(entry.run.providerRunId, resume);
            }
        }
        for (const [sessionKey, providerRunIds] of persistedProviderRunIds) {
            const retained = this.#externalRuns.get(sessionKey);
            const wasReduced = [...providerRunIds].some(
                (providerRunId) => retained?.has(providerRunId) !== true
            );
            if (wasReduced) {
                this.#externalDirtySessions.add(sessionKey);
                this.#externalCapacityReductionSessions.add(sessionKey);
            } else {
                this.#externalDirtySessions.delete(sessionKey);
            }
        }
    }

    #reportAsyncFailure(error: unknown): void {
        try {
            this.#onAsyncFailure(error);
        } catch {
            // Failure reporting has no authority to replace the original failure.
        }
    }

    #beginExternalObservation(observedAtMs: number): ChatProviderObservationBoundary {
        if (
            this.#externalObservationEpoch >= Number.MAX_SAFE_INTEGER ||
            !Number.isSafeInteger(observedAtMs) ||
            observedAtMs < 0
        ) {
            throw new ChatServiceError("capacity");
        }
        this.#externalObservationEpoch += 1;
        return { epoch: this.#externalObservationEpoch, observedAtMs };
    }

    public beginObservation(_sessionKey: string): ChatProviderObservationBoundary {
        return this.#beginExternalObservation(this.#nowMs());
    }

    #companionGeneration(sessionKey: string): number {
        return this.#companionGenerations.get(sessionKey) ?? 1;
    }

    #invalidateCompanionGeneration(sessionKey: string): void {
        const next = this.#companionGeneration(sessionKey) + 1;
        this.#companionGenerations.set(sessionKey, next);
        const active = this.#companionAsks.get(sessionKey);
        if (active === undefined) return;
        active.controller.abort();
        this.#releaseCompanionAsk(sessionKey, active);
    }

    async #handleTranscriptGenerationChange(
        change: ChatTranscriptGenerationChange
    ): Promise<void> {
        this.#invalidateCompanionGeneration(change.sessionKey);
        for (const localRunId of change.retiredRunIds) {
            this.#blockedRuns.add(localRunId);
            const timer = this.#reconciliationTimers.get(localRunId);
            if (timer !== undefined) this.#recoveryScheduler.clear(timer);
            this.#reconciliationTimers.delete(localRunId);
            this.#reconciliationAttempts.delete(localRunId);
            this.#abortAcknowledgedRuns.delete(localRunId);
            const coalescer = this.#coalescers.get(localRunId);
            this.#coalescers.delete(localRunId);
            try {
                await coalescer?.close();
            } catch (error) {
                this.#reportAsyncFailure(error);
            }
            await this.#settleReservation(localRunId, "commit");
        }
        this.#externalRuns.delete(change.sessionKey);
        this.#externalObservationKinds.delete(change.sessionKey);
        this.#externalCapacityReductionSessions.delete(change.sessionKey);
        this.#externalDirtySessions.delete(change.sessionKey);
        this.#externalTruncatedSessions.delete(change.sessionKey);
        try {
            await this.#closeExternalCoalescer(change.sessionKey);
        } catch (error) {
            this.#reportAsyncFailure(error);
        }
        const resumeBackgroundWatch =
            change.status === "ready" &&
            this.#backgroundWatchedSessions.has(change.sessionKey);
        if (!resumeBackgroundWatch) {
            this.#backgroundWatchedSessions.delete(change.sessionKey);
        }
        try {
            await this.#subscriptions.invalidate(change.sessionKey);
            if (!this.#disposed && resumeBackgroundWatch) {
                await this.#subscriptions.touch(change.sessionKey);
            }
        } catch (error) {
            this.#reportAsyncFailure(error);
        }
    }

    #externalSession(sessionKey: string): Map<string, ChatExternalRun> {
        let runs = this.#externalRuns.get(sessionKey);
        if (runs === undefined) {
            runs = new Map();
            this.#externalRuns.set(sessionKey, runs);
        }
        return runs;
    }

    #deleteExternalRun(sessionKey: string, providerRunId: string): boolean {
        const runs = this.#externalRuns.get(sessionKey);
        if (runs === undefined || !runs.delete(providerRunId)) return false;
        const observationKinds = this.#externalObservationKinds.get(sessionKey);
        observationKinds?.delete(providerRunId);
        if (observationKinds?.size === 0) {
            this.#externalObservationKinds.delete(sessionKey);
        }
        if (runs.size === 0) this.#externalRuns.delete(sessionKey);
        this.#externalDirtySessions.add(sessionKey);
        return true;
    }

    #discardEmptyHistoryPlaceholders(
        sessionKey: string,
        liveProviderRunId: string
    ): boolean {
        const runs = this.#externalRuns.get(sessionKey);
        if (runs === undefined) return false;
        let changed = false;
        for (const [providerRunId, run] of runs) {
            if (
                providerRunId !== liveProviderRunId &&
                run.lifecycle === "active" &&
                run.source === "provider-in-flight" &&
                run.text === "" &&
                (run.parts?.every(({ kind }) => kind === "user") ?? true)
            ) {
                changed = this.#deleteExternalRun(sessionKey, providerRunId) || changed;
            }
        }
        return changed;
    }

    #recordExternalObservationKind(
        sessionKey: string,
        providerRunId: string,
        _epoch: number,
        observationKind: "history" | "live",
        historyReplayRemainder?: string | null,
        historyCatchUpSignaled = false,
        pendingAssistantAppend?: string,
        lastProviderSequence = 0,
        terminalObservedAtMs?: number
    ): void {
        let observations = this.#externalObservationKinds.get(sessionKey);
        if (observations === undefined) {
            observations = new Map();
            this.#externalObservationKinds.set(sessionKey, observations);
        }
        const previous = observations.get(providerRunId);
        observations.set(providerRunId, {
            ...(historyCatchUpSignaled ? { historyCatchUpSignaled: true } : {}),
            ...(historyReplayRemainder === undefined ? {} : { historyReplayRemainder }),
            lastProviderSequence: Math.max(
                previous?.lastProviderSequence ?? 0,
                lastProviderSequence
            ),
            observationKind,
            ...(pendingAssistantAppend === undefined ? {} : { pendingAssistantAppend }),
            ...(terminalObservedAtMs === undefined ? {} : { terminalObservedAtMs }),
        });
    }

    #externalRunCount(): number {
        let count = 0;
        for (const runs of this.#externalRuns.values()) count += runs.size;
        return count;
    }

    #evictExternalRun(run: ChatExternalRun): void {
        if (this.#deleteExternalRun(run.sessionKey, run.providerRunId)) {
            this.#externalCapacityReductionSessions.add(run.sessionKey);
            this.#externalTruncatedSessions.add(run.sessionKey);
        }
    }

    #storeExternalRun(run: ChatExternalRun): void {
        this.#externalSession(run.sessionKey).set(run.providerRunId, run);
        this.#externalDirtySessions.add(run.sessionKey);
        const session = this.#externalRuns.get(run.sessionKey);
        while (
            session !== undefined &&
            session.size > chatExternalRunsPerSessionMaximum
        ) {
            const oldest = [...session.values()].toSorted(compareExternalRuns)[0];
            if (oldest === undefined) break;
            this.#evictExternalRun(oldest);
        }
        while (this.#externalRunCount() > chatExternalRunsPerProcessMaximum) {
            const oldest = [...this.#externalRuns.values()]
                .flatMap((runs) => [...runs.values()])
                .toSorted(compareExternalRuns)[0];
            if (oldest === undefined) break;
            this.#evictExternalRun(oldest);
        }
    }

    #nextExternalSnapshotUpdatedAtMs(sessionKey: string): number {
        let currentMaximum = 0;
        for (const run of this.#externalRuns.get(sessionKey)?.values() ?? []) {
            currentMaximum = Math.max(
                currentMaximum,
                run.observedAtMs,
                run.updatedAtMs,
                run.abortBoundary?.attemptedAtMs ?? 0
            );
        }
        return Math.max(this.#nowMs(), currentMaximum + 1);
    }

    async #persistExternalRuntimeSnapshot(
        sessionKey: string,
        drainDirtySessions = true,
        minimumUpdatedAtMs = 0
    ): Promise<void> {
        if (drainDirtySessions) {
            for (const reducedSessionKey of this.#externalCapacityReductionSessions) {
                if (reducedSessionKey === sessionKey) continue;
                await this.#persistExternalRuntimeSnapshot(reducedSessionKey, false);
            }
        }
        const transcript = this.#repository.readTranscriptState(sessionKey);
        if (transcript.status !== "ready") return;
        const runs = [...(this.#externalRuns.get(sessionKey)?.values() ?? [])].toSorted(
            compareExternalRuns
        );
        const snapshotUpdatedAtMs =
            runs.length === 0
                ? this.#nowMs()
                : Math.max(
                      ...runs.flatMap((run) => [
                          run.observedAtMs,
                          run.updatedAtMs,
                          run.abortBoundary?.attemptedAtMs ?? 0,
                      ])
                  );
        const updatedAtMs = Math.max(minimumUpdatedAtMs, snapshotUpdatedAtMs);
        let persisted = false;
        try {
            const metadata = this.#externalObservationKinds.get(sessionKey);
            persisted = await this.#repository.replaceExternalRuntimeSnapshot({
                observationEpoch: Math.max(
                    this.#externalObservationEpoch,
                    ...runs.map(({ observationEpoch }) => observationEpoch)
                ),
                payload: {
                    entries: runs.map((run) => {
                        const resume = metadata?.get(run.providerRunId);
                        return {
                            ...(resume?.historyCatchUpSignaled === true
                                ? { historyCatchUpSignaled: true as const }
                                : {}),
                            ...(resume?.historyReplayRemainder === undefined
                                ? {}
                                : {
                                      historyReplayRemainder:
                                          resume.historyReplayRemainder,
                                  }),
                            lastProviderSequence: resume?.lastProviderSequence ?? 0,
                            observationKind:
                                resume?.observationKind ??
                                (run.source === "provider-in-flight"
                                    ? ("history" as const)
                                    : ("live" as const)),
                            ...(resume?.pendingAssistantAppend === undefined
                                ? {}
                                : {
                                      pendingAssistantAppend:
                                          resume.pendingAssistantAppend,
                                  }),
                            run,
                            ...(run.lifecycle === "terminal-pending-history"
                                ? {
                                      terminalObservedAtMs:
                                          resume?.terminalObservedAtMs ?? run.updatedAtMs,
                                  }
                                : {}),
                        };
                    }),
                    truncated:
                        runs.length > 0 &&
                        this.#externalTruncatedSessions.has(sessionKey),
                },
                sessionKey,
                transcriptGeneration: transcript.currentGeneration,
                updatedAtMs,
            });
        } catch (error) {
            this.#reportAsyncFailure(error);
        }
        if (!persisted) return;
        this.#externalCapacityReductionSessions.delete(sessionKey);
        this.#externalDirtySessions.delete(sessionKey);
        if (runs.length === 0) {
            this.#externalTruncatedSessions.delete(sessionKey);
        }
        if (drainDirtySessions) {
            for (const nextDirtySession of this.#externalDirtySessions) {
                await this.#persistExternalRuntimeSnapshot(nextDirtySession, false);
            }
        }
    }

    #externalCoalescer(sessionKey: string): ChatRuntimeEventCoalescer {
        let coalescer = this.#externalCoalescers.get(sessionKey);
        if (coalescer !== undefined) return coalescer;
        coalescer = new ChatRuntimeEventCoalescer(
            async () => {
                await this.#persistExternalRuntimeSnapshot(sessionKey);
            },
            this.#coalescerScheduler,
            (error) => this.#reportAsyncFailure(error)
        );
        this.#externalCoalescers.set(sessionKey, coalescer);
        return coalescer;
    }

    async #flushExternalCoalescer(sessionKey: string): Promise<void> {
        await this.#externalCoalescers.get(sessionKey)?.flush();
    }

    async #closeExternalCoalescer(sessionKey: string): Promise<void> {
        const coalescer = this.#externalCoalescers.get(sessionKey);
        if (coalescer === undefined) return;
        this.#externalCoalescers.delete(sessionKey);
        await coalescer.close();
    }

    async #pruneStaleExternalRuns(sessionKey: string): Promise<void> {
        const runs = this.#externalRuns.get(sessionKey);
        if (runs === undefined) return;
        const cutoff = this.#nowMs() - chatExternalRunStaleMilliseconds;
        let changed = false;
        for (const [providerRunId, run] of runs) {
            if (run.continuity !== "interrupted" || run.updatedAtMs > cutoff) {
                continue;
            }
            this.#deleteExternalRun(sessionKey, providerRunId);
            changed = true;
        }
        if (!changed) return;
        await this.#flushExternalCoalescer(sessionKey);
        if (runs.size === 0) this.#externalRuns.delete(sessionKey);
        await this.#persistExternalRuntimeSnapshot(sessionKey);
        if (!this.#externalRuns.has(sessionKey)) {
            await this.#closeExternalCoalescer(sessionKey);
        }
    }

    async #handleProviderUserEvent(
        message: Extract<ChatProviderEvent, { kind: "user" }>,
        observation: ChatProviderObservationBoundary,
        reconcileBeforeStore = true
    ): Promise<void> {
        if (reconcileBeforeStore && this.#externalRuns.has(message.sessionKey)) {
            await this.#reconcileExternalSnapshotSession(message.sessionKey);
        }
        if (
            this.#repository.findByProviderCorrelation(
                message.sessionKey,
                message.providerRunId
            ) !== undefined
        ) {
            return;
        }
        const previous = this.#externalRuns
            .get(message.sessionKey)
            ?.get(message.providerRunId);
        if (
            previous?.parts?.some(
                (part) =>
                    part.kind === "user" && part.messageId === message.idempotencyKey
            ) === true
        ) {
            return;
        }
        const previousParts = previous?.parts ?? [];
        const parts = [
            ...previousParts,
            {
                ...(message.attachments === undefined
                    ? {}
                    : { attachments: [...message.attachments] }),
                kind: "user" as const,
                messageId: message.idempotencyKey,
                occurredAtMs: message.receivedAtMs,
                sequence:
                    Math.max(0, ...previousParts.map(({ sequence }) => sequence)) + 1,
                text: message.text,
            },
        ];
        this.#storeExternalRun(
            boundExternalRunProjection({
                ...externalAbortBoundaryFields(previous),
                continuity: previous?.continuity ?? "complete",
                hasUnprojectedActivity: previous?.hasUnprojectedActivity ?? false,
                lifecycle: previous?.lifecycle ?? "active",
                observationEpoch: Math.max(
                    previous?.observationEpoch ?? 0,
                    observation.epoch
                ),
                observedAtMs: Math.max(
                    previous?.observedAtMs ?? 0,
                    observation.observedAtMs
                ),
                parts,
                ...(previous?.plan === undefined ? {} : { plan: previous.plan }),
                projectionTruncated: previous?.projectionTruncated ?? false,
                providerRunId: message.providerRunId,
                sessionKey: message.sessionKey,
                source: previous?.source ?? "provider-runtime",
                ...(previous?.streamResets === undefined
                    ? {}
                    : { streamResets: previous.streamResets }),
                text: previous?.text ?? "",
                updatedAtMs: Math.max(previous?.updatedAtMs ?? 0, message.receivedAtMs),
            })
        );
        await this.#repository.signalRuntimeChanged(new Date(message.receivedAtMs));
        void this.#persistExternalRuntimeSnapshot(message.sessionKey).catch((error) => {
            this.#reportAsyncFailure(error);
        });
    }

    async #projectExternalEvent(
        event: ChatProviderRuntimeEvent,
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        const providerRunId = providerEventRunId(event);
        if (event.kind !== "terminal") {
            this.#discardEmptyHistoryPlaceholders(event.sessionKey, providerRunId);
        }
        const runs = this.#externalRuns.get(event.sessionKey);
        const previous = runs?.get(providerRunId);
        if (
            previous !== undefined &&
            !externalLiveObservationIsNewer(previous, observation)
        ) {
            await (event.kind === "terminal"
                ? this.#repository.signalHistoryChanged()
                : this.#externalCoalescer(event.sessionKey).push(
                      providerEventDraft(event)
                  ));
            return;
        }
        if (event.kind === "terminal") {
            if (
                previous?.abortBoundary !== undefined &&
                (observation.epoch <= previous.abortBoundary.baselineObservationEpoch ||
                    observation.observedAtMs <= previous.abortBoundary.attemptedAtMs)
            ) {
                await this.#repository.signalHistoryChanged();
                return;
            }
            await this.#flushExternalCoalescer(event.sessionKey);
            // This marker survives a fast provider run that completed before this
            // process observed any external projection. Tokens never emit it.
            await this.#repository.signalHistoryChanged();
            if (previous === undefined) return;
            this.#storeExternalRun(
                boundExternalRunProjection({
                    ...previous,
                    lifecycle: "terminal-pending-history",
                    observationEpoch: Math.max(
                        previous.observationEpoch,
                        observation.epoch
                    ),
                    observedAtMs: Math.max(
                        previous.observedAtMs,
                        observation.observedAtMs
                    ),
                    updatedAtMs: Math.max(previous.updatedAtMs, event.receivedAtMs),
                })
            );
            this.#recordExternalObservationKind(
                event.sessionKey,
                providerRunId,
                observation.epoch,
                "live",
                undefined,
                false,
                undefined,
                event.providerSequence,
                event.receivedAtMs
            );
            await this.#persistExternalRuntimeSnapshot(event.sessionKey);
            await this.#closeExternalCoalescer(event.sessionKey);
            return;
        }
        let text = previous?.text ?? "";
        let parts: readonly ChatRuntimeProjectionPart[] =
            previous?.parts ??
            (text === ""
                ? []
                : [
                      {
                          kind: "assistant",
                          segmentId: `${providerRunId}:history-assistant`,
                          sequence: 1,
                          streamId: "assistant",
                          text,
                      },
                  ]);
        const beganAfterProviderSequenceOne =
            previous === undefined && event.providerSequence > 1;
        let hasUnprojectedActivity =
            previous?.hasUnprojectedActivity ?? beganAfterProviderSequenceOne;
        let projectionTruncated =
            (previous?.projectionTruncated ?? false) || beganAfterProviderSequenceOne;
        let plan = previous?.plan;
        const streamResets = externalStreamResetsAfterEvent(previous, event);
        const previousObservationKind = this.#externalObservationKinds
            .get(event.sessionKey)
            ?.get(providerRunId);
        let historyReplayRemainder =
            observation.observedAtMs === previous?.observedAtMs
                ? previousObservationKind?.historyReplayRemainder
                : undefined;
        let assistantAppendText = event.kind === "delta" ? event.text : "";
        let suppressAssistantAppend = false;
        let historyCatchUpSignaled =
            previousObservationKind?.historyCatchUpSignaled ?? false;
        let pendingAssistantAppend = previousObservationKind?.pendingAssistantAppend;
        let signalHistoryCatchUp = false;
        if (
            event.kind === "delta" &&
            event.stream === "assistant" &&
            event.mode !== "append"
        ) {
            historyReplayRemainder = undefined;
            historyCatchUpSignaled = false;
            pendingAssistantAppend = undefined;
        }
        if (
            event.kind === "delta" &&
            event.stream === "assistant" &&
            event.mode === "append" &&
            pendingAssistantAppend !== undefined
        ) {
            pendingAssistantAppend = safeCodeUnitPrefix(
                pendingAssistantAppend + event.text,
                externalPendingAssistantAppendMaximumCodeUnits
            );
            suppressAssistantAppend = true;
        } else if (
            event.kind === "delta" &&
            event.stream === "assistant" &&
            event.mode === "append" &&
            historyReplayRemainder !== undefined
        ) {
            if (historyReplayRemainder === null) {
                suppressAssistantAppend = true;
            } else if (historyReplayRemainder.startsWith(event.text)) {
                historyReplayRemainder = historyReplayRemainder.slice(event.text.length);
                suppressAssistantAppend = true;
            } else if (event.text.startsWith(historyReplayRemainder)) {
                assistantAppendText = event.text.slice(historyReplayRemainder.length);
                historyReplayRemainder = "";
            } else {
                historyReplayRemainder = null;
                suppressAssistantAppend = true;
            }
            if (suppressAssistantAppend && historyReplayRemainder === null) {
                pendingAssistantAppend = safeCodeUnitPrefix(
                    event.text,
                    externalPendingAssistantAppendMaximumCodeUnits
                );
            }
            if (pendingAssistantAppend !== undefined && !historyCatchUpSignaled) {
                historyCatchUpSignaled = true;
                signalHistoryCatchUp = true;
            }
        }
        if (event.kind === "compaction") {
            parts = updateExternalCompactionPart(parts, event);
        } else if (event.kind === "delta" && event.stream === "assistant") {
            if (!suppressAssistantAppend) {
                const projectedEvent =
                    assistantAppendText === event.text
                        ? event
                        : { ...event, text: assistantAppendText };
                const previousText = text;
                text = projectedEvent.text;
                if (projectedEvent.mode === "append") {
                    text = previousText + projectedEvent.text;
                }
                if (projectedEvent.mode === "merge") {
                    text = mergeChatStreamText(previousText, projectedEvent.text);
                }
                parts = updateExternalStreamPart(parts, projectedEvent);
            }
        } else if (event.kind === "delta" && event.stream === "thinking") {
            parts = updateExternalStreamPart(parts, event);
        } else if (event.kind === "tool") {
            parts = updateExternalToolPart(parts, event);
        } else if (event.kind === "item") {
            parts = updateExternalItemPart(parts, event);
        } else if (event.kind === "plan") {
            plan = {
                ...((event.explanation ?? plan?.explanation) === undefined
                    ? {}
                    : { explanation: event.explanation ?? plan?.explanation }),
                phase: "update",
                steps: [...event.steps],
            };
        }
        if (text.length > chatMessageTextMaximumCodeUnits) {
            text = safeCodeUnitPrefix(text, chatMessageTextMaximumCodeUnits);
            hasUnprojectedActivity = true;
            projectionTruncated = true;
        }
        const oversizedStreamPart = parts.some(
            (part) =>
                (part.kind === "assistant" || part.kind === "thinking") &&
                part.text.length > chatMessageTextMaximumCodeUnits
        );
        if (oversizedStreamPart) {
            parts = parts.map((part) =>
                part.kind === "assistant" || part.kind === "thinking"
                    ? {
                          ...part,
                          text: safeCodeUnitPrefix(
                              part.text,
                              chatMessageTextMaximumCodeUnits
                          ),
                      }
                    : part
            );
            hasUnprojectedActivity = true;
            projectionTruncated = true;
        }
        const normalizedParts = normalizeExternalProjectionParts(parts);
        parts = normalizedParts.parts;
        if (normalizedParts.partsExceeded) {
            hasUnprojectedActivity = true;
            projectionTruncated = true;
        }
        const candidate = {
            ...externalAbortBoundaryFields(previous),
            continuity:
                previous?.continuity ??
                (beganAfterProviderSequenceOne ? "interrupted" : "complete"),
            hasUnprojectedActivity,
            lifecycle: previous?.lifecycle ?? "active",
            observationEpoch: Math.max(
                previous?.observationEpoch ?? 0,
                observation.epoch
            ),
            observedAtMs: Math.max(previous?.observedAtMs ?? 0, observation.observedAtMs),
            parts: [...parts],
            ...(plan === undefined ? {} : { plan }),
            projectionTruncated,
            providerRunId,
            sessionKey: event.sessionKey,
            source: "provider-runtime" as const,
            ...(streamResets === undefined ? {} : { streamResets }),
            text,
            updatedAtMs: Math.max(previous?.updatedAtMs ?? 0, event.receivedAtMs),
        };
        this.#storeExternalRun(boundExternalRunProjection(candidate));
        this.#recordExternalObservationKind(
            event.sessionKey,
            providerRunId,
            observation.epoch,
            "live",
            historyReplayRemainder,
            historyCatchUpSignaled,
            pendingAssistantAppend,
            event.providerSequence
        );
        await this.#externalCoalescer(event.sessionKey).push(providerEventDraft(event));
        if (signalHistoryCatchUp) {
            await this.#repository.signalHistoryChanged();
        }
    }

    async #acknowledgeEventAlias(
        localRunId: string,
        providerRunId: string
    ): Promise<void> {
        const run = this.#repository.findRun(localRunId);
        if (run?.providerRunId === undefined) {
            await this.#repository.acknowledgeDispatch(localRunId, providerRunId);
        }
    }

    #coalescer(localRunId: string): ChatRuntimeEventCoalescer {
        let coalescer = this.#coalescers.get(localRunId);
        if (coalescer !== undefined) return coalescer;
        coalescer = new ChatRuntimeEventCoalescer(
            async (events) => {
                await this.#repository.appendEvents(localRunId, events);
            },
            this.#coalescerScheduler,
            (error) => {
                void this.#blockAndReconcile(localRunId, error);
            }
        );
        this.#coalescers.set(localRunId, coalescer);
        return coalescer;
    }

    async #handleProviderEvent(
        event: ChatProviderEvent,
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        if (this.#disposed) return;
        if (event.kind === "user") {
            await this.#handleProviderUserEvent(event, observation);
            return;
        }
        const providerRunId = providerEventRunId(event);
        const run = this.#repository.findByProviderCorrelation(
            event.sessionKey,
            providerRunId
        );
        if (run === undefined) {
            if (
                this.#repository.isRetiredProviderCorrelation(
                    event.sessionKey,
                    providerRunId
                )
            ) {
                return;
            }
            await this.#projectExternalEvent(event, observation);
            return;
        }
        if (this.#blockedRuns.has(run.id)) return;
        try {
            await this.#acknowledgeEventAlias(run.id, providerRunId);
            const coalescer = this.#coalescer(run.id);
            await coalescer.push(providerEventDraft(event));
            if (event.kind === "terminal") {
                await coalescer.close();
                this.#coalescers.delete(run.id);
                this.#blockedRuns.add(run.id);
                this.#startReconciliation(run.id);
            }
        } catch (error) {
            await this.#blockAndReconcile(run.id, error);
        }
    }

    async #appendInterrupted(localRunId: string): Promise<void> {
        const run = this.#repository.findRun(localRunId);
        if (
            run === undefined ||
            terminalState(run.state) ||
            run.state === "interrupted"
        ) {
            return;
        }
        await this.#repository.appendEvents(localRunId, [
            { kind: "interrupted", occurredAtMs: this.#nowMs() },
        ]);
    }

    async #blockAndReconcile(localRunId: string, cause?: unknown): Promise<void> {
        this.#blockedRuns.add(localRunId);
        const coalescer = this.#coalescers.get(localRunId);
        this.#coalescers.delete(localRunId);
        try {
            await coalescer?.close();
        } catch (error) {
            cause ??= error;
        }
        try {
            await this.#appendInterrupted(localRunId);
        } catch (error) {
            cause ??= error;
        }
        if (cause !== undefined) this.#reportAsyncFailure(cause);
        this.#startReconciliation(localRunId);
    }

    async #handleProviderGap(
        gap: ChatProviderEventGap,
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        const run = this.#repository.findByProviderCorrelation(
            gap.sessionKey,
            gap.providerRunId
        );
        if (run === undefined) {
            if (
                this.#repository.isRetiredProviderCorrelation(
                    gap.sessionKey,
                    gap.providerRunId
                )
            ) {
                return;
            }
            await this.#flushExternalCoalescer(gap.sessionKey);
            const previous = this.#externalRuns
                .get(gap.sessionKey)
                ?.get(gap.providerRunId);
            this.#storeExternalRun(
                boundExternalRunProjection({
                    ...externalAbortBoundaryFields(previous),
                    continuity: "interrupted",
                    hasUnprojectedActivity: true,
                    lifecycle: previous?.lifecycle ?? "active",
                    observationEpoch: Math.max(
                        previous?.observationEpoch ?? 0,
                        observation.epoch
                    ),
                    observedAtMs: Math.max(
                        previous?.observedAtMs ?? 0,
                        observation.observedAtMs
                    ),
                    ...(previous?.parts === undefined ? {} : { parts: previous.parts }),
                    ...(previous?.plan === undefined ? {} : { plan: previous.plan }),
                    ...(previous?.streamResets === undefined
                        ? {}
                        : { streamResets: previous.streamResets }),
                    providerRunId: gap.providerRunId,
                    sessionKey: gap.sessionKey,
                    source: previous?.source ?? "provider-runtime",
                    text: previous?.text ?? "",
                    projectionTruncated: true,
                    updatedAtMs: Math.max(previous?.updatedAtMs ?? 0, this.#nowMs()),
                })
            );
            this.#recordExternalObservationKind(
                gap.sessionKey,
                gap.providerRunId,
                observation.epoch,
                "live",
                undefined,
                false,
                undefined,
                Math.max(0, gap.expectedSequence - 1)
            );
            await this.#persistExternalRuntimeSnapshot(gap.sessionKey);
            return;
        }
        await this.#blockAndReconcile(
            run.id,
            new ChatProviderSequenceGapError(gap.expectedSequence, gap.receivedSequence)
        );
    }

    async #handleSessionReconciliation(
        sessionKey: string,
        reason: ChatProviderReconciliationReason,
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        const candidates = this.#repository
            .listRecoveryCandidates()
            .filter(({ run }) => run.sessionKey === sessionKey);
        if (reason === "backpressure") {
            await Promise.all(
                candidates.map(({ run }) => this.#blockAndReconcile(run.id))
            );
        } else {
            for (const { run } of candidates) this.#startReconciliation(run.id);
        }
        await this.#repository.signalHistoryChanged();
        const external = this.#externalRuns.get(sessionKey);
        if (reason === "backpressure" && external !== undefined) {
            await this.#flushExternalCoalescer(sessionKey);
            for (const [providerRunId, run] of external) {
                external.set(providerRunId, {
                    ...run,
                    continuity: "interrupted",
                    hasUnprojectedActivity: true,
                    observationEpoch: Math.max(run.observationEpoch, observation.epoch),
                    observedAtMs: Math.max(run.observedAtMs, observation.observedAtMs),
                    projectionTruncated: true,
                    updatedAtMs: Math.max(run.updatedAtMs, this.#nowMs()),
                });
            }
            await this.#persistExternalRuntimeSnapshot(sessionKey);
        }
    }

    async #readReconciliationHistory(
        sessionKey: string,
        signal?: AbortSignal
    ): Promise<
        Readonly<{
            inFlightRun?: ChatProviderInFlightRun;
            messages: readonly ChatMessage[];
            sessionId?: string;
        }>
    > {
        const messages: ChatMessage[] = [];
        let inFlightRun: ChatProviderInFlightRun | undefined;
        let offset = 0;
        let sessionId: string | undefined;
        for (
            let pageIndex = 0;
            pageIndex < chatHistoryProviderPageMaximum;
            pageIndex += 1
        ) {
            const page = await this.#provider.history(
                {
                    limit: 100 - messages.length,
                    maxChars: chatHistoryResponseMaximumBytes,
                    offset,
                    sessionKey,
                },
                signal
            );
            if (pageIndex === 0) inFlightRun = page.inFlightRun;
            if (
                sessionId !== undefined &&
                page.sessionId !== undefined &&
                page.sessionId !== sessionId
            ) {
                throw new ChatProviderUnavailableError();
            }
            sessionId ??= page.sessionId;
            messages.push(...page.messages);
            if (!page.hasMore || messages.length >= 100) break;
            const nextOffset = page.nextOffset;
            if (nextOffset === undefined || nextOffset <= offset) {
                throw new ChatProviderUnavailableError();
            }
            offset = nextOffset;
        }
        return Object.freeze({
            ...(inFlightRun === undefined ? {} : { inFlightRun }),
            messages: Object.freeze(messages),
            ...(sessionId === undefined ? {} : { sessionId }),
        });
    }

    async #reconcileOnce(localRunId: string): Promise<boolean> {
        const intent = this.#repository.readIntent(localRunId);
        if (intent === undefined) return true;
        let history: Readonly<{
            inFlightRun?: ChatProviderInFlightRun;
            messages: readonly ChatMessage[];
            sessionId?: string;
        }>;
        try {
            history = await this.#readReconciliationHistory(intent.run.sessionKey);
        } catch (error) {
            this.#reportAsyncFailure(error);
            return false;
        }
        const finalMessage = findFinalHistoryMessage(
            history.messages,
            localRunId,
            intent.run.providerRunId,
            intent.request.idempotencyKey
        );
        if (finalMessage !== undefined) {
            const providerRunId = finalMessage.runId;
            if (
                intent.dispatchAttempted &&
                intent.run.providerRunId === undefined &&
                providerRunId !== undefined
            ) {
                await this.#repository.acknowledgeDispatch(localRunId, providerRunId);
            }
            const current = this.#repository.findRun(localRunId);
            if (current !== undefined && !terminalState(current.state)) {
                await this.#repository.appendEvents(localRunId, [
                    {
                        kind: "terminal",
                        occurredAtMs: this.#nowMs(),
                        outcome: "completed",
                        ...(providerRunId === undefined ? {} : { providerRunId }),
                    },
                ]);
            }
            await this.#repository.appendEvents(localRunId, [
                {
                    historyMessageId: finalMessage.id,
                    kind: "reconciled",
                    occurredAtMs: this.#nowMs(),
                },
            ]);
            await this.#settleReservation(localRunId, "commit");
            this.#blockedRuns.delete(localRunId);
            this.#abortAcknowledgedRuns.delete(localRunId);
            this.#reconciliationAttempts.delete(localRunId);
            return true;
        }
        const inFlight = history.inFlightRun;
        if (
            inFlight !== undefined &&
            (inFlight.runId === intent.request.idempotencyKey ||
                inFlight.runId === intent.run.providerRunId)
        ) {
            if (intent.dispatchAttempted && intent.run.providerRunId === undefined) {
                await this.#repository.acknowledgeDispatch(localRunId, inFlight.runId);
            }
            // No provider sequence exists on this snapshot. It may prove identity,
            // but never advances or resets the durable provider watermark.
            return false;
        }
        return false;
    }

    #reconcileSingleFlight(localRunId: string): Promise<boolean> {
        const current = this.#reconciliationInFlight.get(localRunId);
        if (current !== undefined) return current;
        const operation = this.#reconcileOnce(localRunId).catch((error: unknown) => {
            this.#reportAsyncFailure(error);
            return false;
        });
        this.#reconciliationInFlight.set(localRunId, operation);
        void operation.finally(() => {
            if (this.#reconciliationInFlight.get(localRunId) === operation) {
                this.#reconciliationInFlight.delete(localRunId);
            }
        });
        return operation;
    }

    async #settleReconciliationDeadline(localRunId: string): Promise<void> {
        const intent = this.#repository.readIntent(localRunId);
        if (intent === undefined || terminalState(intent.run.state)) return;
        const coalescer = this.#coalescers.get(localRunId);
        this.#coalescers.delete(localRunId);
        try {
            await coalescer?.close();
        } catch (error) {
            this.#reportAsyncFailure(error);
        }
        await this.#repository.settleUnresolved(localRunId);
        await this.#settleReservation(localRunId, "release");
        this.#blockedRuns.delete(localRunId);
        this.#abortAcknowledgedRuns.delete(localRunId);
        this.#reconciliationAttempts.delete(localRunId);
        const timer = this.#reconciliationTimers.get(localRunId);
        if (timer !== undefined) this.#recoveryScheduler.clear(timer);
        this.#reconciliationTimers.delete(localRunId);
        await this.#subscriptions.releaseIfUnpinned(intent.run.sessionKey);
    }

    #startReconciliation(localRunId: string): void {
        if (
            this.#disposed ||
            this.#reconciliationTimers.has(localRunId) ||
            this.#reconciliationInFlight.has(localRunId)
        ) {
            return;
        }
        const initialIntent = this.#repository.readIntent(localRunId);
        if (initialIntent === undefined) return;
        const initialDeadline =
            initialIntent.run.admittedAtMs + reconciliationLifecycleMilliseconds;
        if (this.#nowMs() >= initialDeadline) {
            void this.#settleReconciliationDeadline(localRunId).catch((error: unknown) =>
                this.#reportAsyncFailure(error)
            );
            return;
        }
        void this.#reconcileAndSchedule(localRunId).catch((error: unknown) =>
            this.#reportAsyncFailure(error)
        );
    }

    async #reconcileAndSchedule(localRunId: string): Promise<void> {
        const complete = await this.#reconcileSingleFlight(localRunId);
        if (complete || this.#disposed) return;
        const intent = this.#repository.readIntent(localRunId);
        if (intent === undefined) return;
        const remaining =
            intent.run.admittedAtMs + reconciliationLifecycleMilliseconds - this.#nowMs();
        if (remaining <= 0) {
            await this.#settleReconciliationDeadline(localRunId);
            return;
        }
        const attempt = (this.#reconciliationAttempts.get(localRunId) ?? 0) + 1;
        this.#reconciliationAttempts.set(localRunId, attempt);
        const delay = Math.min(
            remaining,
            reconciliationRetryMaximumMilliseconds,
            reconciliationRetryMilliseconds * 2 ** Math.min(attempt - 1, 10)
        );
        const handle = this.#recoveryScheduler.schedule(() => {
            this.#reconciliationTimers.delete(localRunId);
            this.#startReconciliation(localRunId);
        }, delay);
        this.#reconciliationTimers.set(localRunId, handle);
    }

    async #terminalFailure(
        localRunId: string,
        code: string,
        message: string
    ): Promise<void> {
        const run = this.#repository.findRun(localRunId);
        if (run === undefined || terminalState(run.state)) return;
        await this.#repository.appendEvents(localRunId, [
            {
                errorCode: code,
                errorMessage: message,
                kind: "terminal",
                occurredAtMs: this.#nowMs(),
                outcome: "error",
            },
        ]);
    }

    async #settleReservation(
        localRunId: string,
        settlement: "commit" | "release",
        signal?: AbortSignal
    ): Promise<void> {
        const pending = this.#pendingReservations.get(localRunId);
        if (pending === undefined) return;
        this.#pendingReservations.set(localRunId, {
            reservation: pending.reservation,
            settlement,
        });
        try {
            await (settlement === "commit"
                ? pending.reservation.commit(signal)
                : pending.reservation.release(signal));
            this.#pendingReservations.delete(localRunId);
        } catch (error) {
            this.#reportAsyncFailure(error);
        }
    }

    public async observeInFlightRun(
        sessionKey: string,
        inFlightRun: ChatProviderInFlightRun | undefined,
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        if (inFlightRun === undefined) {
            await this.#flushExternalCoalescer(sessionKey);
            const runs = this.#externalRuns.get(sessionKey);
            let changed = false;
            if (runs !== undefined) {
                for (const [providerRunId, run] of runs) {
                    if (
                        run.source === "provider-in-flight" &&
                        run.lifecycle === "active" &&
                        externalObservationIsStrictlyNewer(run, observation) &&
                        (run.abortBoundary === undefined ||
                            (observation.epoch >
                                run.abortBoundary.baselineObservationEpoch &&
                                observation.observedAtMs >
                                    run.abortBoundary.attemptedAtMs))
                    ) {
                        this.#deleteExternalRun(sessionKey, providerRunId);
                        changed = true;
                    }
                }
                if (runs.size === 0) this.#externalRuns.delete(sessionKey);
            }
            if (
                !this.#externalRuns.has(sessionKey) &&
                this.#externalTruncatedSessions.delete(sessionKey)
            ) {
                changed = true;
            }
            if (changed) await this.#persistExternalRuntimeSnapshot(sessionKey);
            if (!this.#externalRuns.has(sessionKey)) {
                await this.#closeExternalCoalescer(sessionKey);
            }
            return;
        }
        await this.#flushExternalCoalescer(sessionKey);
        const local = this.#repository.findByProviderCorrelation(
            sessionKey,
            inFlightRun.runId
        );
        if (local !== undefined) return;
        const previous = this.#externalRuns.get(sessionKey)?.get(inFlightRun.runId);
        const activeLiveRun = [
            ...(this.#externalRuns.get(sessionKey)?.values() ?? []),
        ].find(
            (run) =>
                run.providerRunId !== inFlightRun.runId &&
                run.lifecycle === "active" &&
                run.source === "provider-runtime"
        );
        if (
            previous === undefined &&
            activeLiveRun !== undefined &&
            inFlightRun.text === ""
        ) {
            this.#storeExternalRun(
                boundExternalRunProjection({
                    ...activeLiveRun,
                    observationEpoch: Math.max(
                        activeLiveRun.observationEpoch,
                        observation.epoch
                    ),
                    observedAtMs: Math.max(
                        activeLiveRun.observedAtMs,
                        observation.observedAtMs
                    ),
                })
            );
            await this.#persistExternalRuntimeSnapshot(sessionKey);
            return;
        }
        if (
            previous !== undefined &&
            (!externalObservationIsStrictlyNewer(previous, observation) ||
                (previous.abortBoundary !== undefined &&
                    (observation.epoch <=
                        previous.abortBoundary.baselineObservationEpoch ||
                        observation.observedAtMs <=
                            previous.abortBoundary.attemptedAtMs)))
        ) {
            return;
        }
        const mergedParts = mergeExternalInFlightParts(
            previous,
            inFlightRun.runId,
            inFlightRun.text,
            observation.observedAtMs
        );
        const representedSuffix =
            previous === undefined || !inFlightRun.text.startsWith(previous.text)
                ? undefined
                : inFlightRun.text.slice(previous.text.length);
        const historyReplayRemainder =
            representedSuffix === undefined || representedSuffix === ""
                ? null
                : representedSuffix;
        const planSteps = inFlightRun.plan?.steps ?? previous?.plan?.steps;
        const planExplanation =
            inFlightRun.plan?.explanation ?? previous?.plan?.explanation;
        this.#storeExternalRun(
            boundExternalRunProjection({
                ...externalAbortBoundaryFields(previous),
                continuity: "complete",
                hasUnprojectedActivity:
                    (previous?.hasUnprojectedActivity ?? false) ||
                    mergedParts.projectionTruncated,
                lifecycle: previous?.lifecycle ?? "active",
                observationEpoch: Math.max(
                    previous?.observationEpoch ?? 0,
                    observation.epoch
                ),
                observedAtMs: Math.max(
                    previous?.observedAtMs ?? 0,
                    observation.observedAtMs
                ),
                parts: [...mergedParts.parts],
                ...(planSteps === undefined
                    ? {}
                    : {
                          plan: {
                              ...(planExplanation === undefined
                                  ? {}
                                  : { explanation: planExplanation }),
                              phase: "update",
                              steps: [...planSteps],
                          },
                      }),
                providerRunId: inFlightRun.runId,
                sessionKey,
                source: previous?.source ?? "provider-in-flight",
                ...(previous?.streamResets === undefined
                    ? {}
                    : { streamResets: previous.streamResets }),
                text: inFlightRun.text,
                projectionTruncated:
                    (previous?.projectionTruncated ?? false) ||
                    mergedParts.projectionTruncated,
                updatedAtMs: Math.max(previous?.updatedAtMs ?? 0, this.#nowMs()),
            })
        );
        this.#recordExternalObservationKind(
            sessionKey,
            inFlightRun.runId,
            observation.epoch,
            "history",
            historyReplayRemainder
        );
        await this.#persistExternalRuntimeSnapshot(sessionKey);
    }

    public async observeHistoryMessages(
        sessionKey: string,
        messages: readonly ChatMessage[],
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        const runs = this.#externalRuns.get(sessionKey);
        if (runs === undefined) return;
        const finalIdentities = new Set(
            messages
                .filter(({ role }) => role === "assistant")
                .flatMap(({ idempotencyKey, runId }) => [
                    ...(idempotencyKey === undefined ? [] : [idempotencyKey]),
                    ...(runId === undefined ? [] : [runId]),
                ])
        );
        let changed = false;
        let retired = false;
        const userMessages = messages.filter(({ role }) => role === "user");
        const activeExternalRunCount = [...runs.values()].filter(
            ({ lifecycle }) => lifecycle === "active"
        ).length;
        for (const [providerRunId, run] of runs) {
            const historyMayRetireRun =
                run.lifecycle === "terminal-pending-history" ||
                run.source === "provider-in-flight";
            const terminalConfirmed =
                run.lifecycle === "terminal-pending-history" &&
                historyConfirmsExternalTerminal(run, messages, runs.size);
            if (
                historyMayRetireRun &&
                (finalIdentities.has(providerRunId) || terminalConfirmed) &&
                !externalRunRemainsInFlightAtObservation(run, observation)
            ) {
                retired = this.#deleteExternalRun(sessionKey, providerRunId) || retired;
                changed = retired || changed;
                continue;
            }
            if (
                run.lifecycle !== "active" ||
                !externalObservationIsCurrentOrNewer(run, observation) ||
                (run.abortBoundary !== undefined &&
                    (observation.epoch <= run.abortBoundary.baselineObservationEpoch ||
                        observation.observedAtMs <= run.abortBoundary.attemptedAtMs))
            ) {
                continue;
            }
            const candidates = externalHistoryUserCandidates(
                run,
                userMessages,
                activeExternalRunCount
            );
            const merged = mergeExternalHistoryUserAnchors(run, candidates);
            if (!merged.changed) continue;
            this.#storeExternalRun(
                boundExternalRunProjection({
                    ...run,
                    hasUnprojectedActivity:
                        run.hasUnprojectedActivity || merged.projectionTruncated,
                    observationEpoch: Math.max(run.observationEpoch, observation.epoch),
                    observedAtMs: Math.max(run.observedAtMs, observation.observedAtMs),
                    parts: [...merged.parts],
                    projectionTruncated: merged.projectionTruncated,
                    updatedAtMs: this.#nextExternalSnapshotUpdatedAtMs(sessionKey),
                })
            );
            changed = true;
        }
        for (const providerRunId of finalIdentities) {
            const run = runs.get(providerRunId);
            if (
                run !== undefined &&
                run.source === "provider-runtime" &&
                run.lifecycle === "active"
            ) {
                continue;
            }
            if (
                run !== undefined &&
                (externalRunRemainsInFlightAtObservation(run, observation) ||
                    !externalObservationIsCurrentOrNewer(run, observation) ||
                    (run.abortBoundary !== undefined &&
                        (observation.epoch <=
                            run.abortBoundary.baselineObservationEpoch ||
                            observation.observedAtMs <= run.abortBoundary.attemptedAtMs)))
            ) {
                continue;
            }
            retired = this.#deleteExternalRun(sessionKey, providerRunId) || retired;
            changed = retired || changed;
        }
        if (!changed) return;
        await this.#flushExternalCoalescer(sessionKey);
        if (retired) await this.#repository.signalHistoryChanged();
        await this.#persistExternalRuntimeSnapshot(sessionKey);
        if (!this.#externalRuns.has(sessionKey)) {
            await this.#closeExternalCoalescer(sessionKey);
        }
    }

    public async history(
        rawInput: ChatHistoryInput,
        signal?: AbortSignal
    ): Promise<ChatHistoryOutput> {
        try {
            const input = v.parse(chatHistoryInputSchema, rawInput);
            await this.#touchSubscription(input.sessionKey);
            return await this.#historyService.history(input, signal);
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async getMessage(
        rawInput: ChatMessageGetInput,
        signal?: AbortSignal
    ): Promise<ChatMessageGetOutput> {
        try {
            const input = v.parse(chatMessageGetInputSchema, rawInput);
            await this.#touchSubscription(input.sessionKey);
            return await this.#historyService.getMessage(input, signal);
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async runtime(
        rawInput: ChatRuntimeInput,
        _signal?: AbortSignal
    ): Promise<ChatRuntimeOutput> {
        try {
            const input = v.parse(chatRuntimeInputSchema, rawInput);
            await this.#touchSubscription(input.sessionKey);
            await this.#pruneStaleExternalRuns(input.sessionKey);
            const durable = this.#repository.readRuntime(input);
            const externalRuns = [
                ...(this.#externalRuns.get(input.sessionKey)?.values() ?? []),
            ].toSorted(compareExternalRuns);
            return budgetExternalRuns(
                durable,
                externalRuns,
                this.#externalTruncatedSessions.has(input.sessionKey)
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async prepareAttachmentTicket(
        rawInput: ChatAttachmentTicketPrepareInput,
        actorId: string,
        signal?: AbortSignal
    ): Promise<ChatAttachmentTicketPrepareOutput> {
        try {
            const input = v.parse(chatAttachmentTicketPrepareInputSchema, rawInput);
            return v.parse(
                chatAttachmentTicketPrepareOutputSchema,
                await this.#attachmentPreparer.prepare(input, actorId, signal)
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async send(
        rawInput: ChatSendInput,
        actor: ChatAdmissionActor,
        signal?: AbortSignal
    ): Promise<ChatSendOutput> {
        const input = v.parse(chatSendInputSchema, rawInput);
        let admission;
        try {
            admission = await this.#repository.admit(input, actor);
        } catch (error) {
            throw this.#serviceFailure(error);
        }
        if (admission.admission === "replayed") {
            return v.parse(chatSendOutputSchema, admission);
        }
        try {
            await this.#subscriptions.touch(input.sessionKey);
        } catch (error) {
            await this.#terminalFailure(
                input.clientRunId,
                "subscription_unavailable",
                "Chat runtime subscription could not be established before dispatch"
            );
            throw this.#serviceFailure(error);
        }
        let reservation: ChatAttachmentTicketReservation | undefined;
        if (input.attachmentTicketId !== undefined) {
            try {
                reservation = await this.#attachmentConsumer.reserve(
                    {
                        actorId: actor.id,
                        idempotencyKey: input.idempotencyKey,
                        sessionKey: input.sessionKey,
                        ticketId: input.attachmentTicketId,
                    },
                    signal
                );
            } catch (error) {
                await this.#terminalFailure(
                    input.clientRunId,
                    "attachment_unavailable",
                    "Chat attachments could not be recovered for dispatch"
                );
                throw this.#serviceFailure(error);
            }
        }
        let dispatch;
        try {
            dispatch = await this.#repository.beginDispatch(input.clientRunId);
        } catch (error) {
            try {
                await reservation?.release();
            } catch (releaseError) {
                this.#reportAsyncFailure(releaseError);
            }
            await this.#terminalFailure(
                input.clientRunId,
                "dispatch_admission_failed",
                "Chat dispatch could not be durably admitted"
            );
            throw this.#serviceFailure(error);
        }
        if (!dispatch.shouldDispatch) {
            await reservation?.release();
            return v.parse(chatSendOutputSchema, {
                admission: "replayed",
                run: dispatch.run,
            });
        }
        if (reservation !== undefined) {
            this.#pendingReservations.set(input.clientRunId, {
                reservation,
                settlement: "hold",
            });
        }
        let acknowledgement;
        try {
            const activeExternalRun = [
                ...(this.#externalRuns.get(input.sessionKey)?.values() ?? []),
            ]
                .filter(({ lifecycle }) => lifecycle === "active")
                .toSorted(compareExternalRuns)
                .at(-1);
            const activeLocalRun = this.#repository
                .listRecoverableRuns()
                .filter(
                    ({ id, sessionKey }) =>
                        id !== input.clientRunId && sessionKey === input.sessionKey
                )
                .toSorted(
                    (left, right) =>
                        left.updatedAtMs - right.updatedAtMs ||
                        left.id.localeCompare(right.id)
                )
                .at(-1);
            const activeLocalIntent =
                activeLocalRun === undefined
                    ? undefined
                    : this.#repository.readIntent(activeLocalRun.id);
            const localProviderRun: ActiveProviderRun | undefined =
                activeLocalRun === undefined || activeLocalIntent === undefined
                    ? undefined
                    : {
                          providerRunId:
                              activeLocalRun.providerRunId ??
                              activeLocalIntent.request.idempotencyKey,
                          updatedAtMs: activeLocalRun.updatedAtMs,
                      };
            const externalProviderRun: ActiveProviderRun | undefined =
                activeExternalRun === undefined
                    ? undefined
                    : {
                          providerRunId: activeExternalRun.providerRunId,
                          updatedAtMs: activeExternalRun.updatedAtMs,
                      };
            let activeProviderRun = externalProviderRun;
            if (
                localProviderRun !== undefined &&
                (activeProviderRun === undefined ||
                    localProviderRun.updatedAtMs >= activeProviderRun.updatedAtMs)
            ) {
                activeProviderRun = localProviderRun;
            }
            acknowledgement = await this.#provider.send(
                {
                    attachments: reservation?.attachments ?? [],
                    ...(input.settings?.fastMode === undefined
                        ? {}
                        : { fastMode: input.settings.fastMode }),
                    idempotencyKey: input.idempotencyKey,
                    message: input.message,
                    ...(activeProviderRun === undefined
                        ? {}
                        : {
                              expectedRunId: activeProviderRun.providerRunId,
                              queueMode: "steer" as const,
                          }),
                    sessionKey: input.sessionKey,
                    ...(input.settings?.thinkingLevel === undefined
                        ? {}
                        : { thinking: input.settings.thinkingLevel }),
                },
                signal
            );
        } catch (error) {
            if (error instanceof ChatProviderUnknownOutcomeError) {
                try {
                    await this.#repository.markOutcomeUnknown(input.clientRunId);
                } finally {
                    // Dispatch was attempted and cannot safely be retried. Consume the
                    // one-shot ticket and free raw/base64 bytes before reconciliation.
                    await this.#settleReservation(input.clientRunId, "commit");
                    this.#startReconciliation(input.clientRunId);
                }
                throw new ChatServiceError("unknown-outcome", { cause: error });
            }
            try {
                await this.#terminalFailure(
                    input.clientRunId,
                    "dispatch_failed",
                    "Chat provider dispatch failed before acknowledgement"
                );
            } finally {
                await this.#settleReservation(input.clientRunId, "release");
            }
            throw this.#serviceFailure(error);
        }
        let run;
        try {
            run = await this.#repository.acknowledgeDispatch(
                input.clientRunId,
                acknowledgement.runId
            );
        } catch (error) {
            // The provider ACK proves the attachment was dispatched even if the
            // local acknowledgement transaction failed.
            await this.#settleReservation(input.clientRunId, "commit");
            try {
                await this.#repository.markOutcomeUnknown(input.clientRunId);
            } finally {
                this.#startReconciliation(input.clientRunId);
            }
            throw new ChatServiceError("unknown-outcome", { cause: error });
        }
        await this.#settleReservation(input.clientRunId, "commit");
        return v.parse(chatSendOutputSchema, {
            admission: "created",
            run,
        });
    }

    async #abortOnce(
        input: LocalChatAbortInput,
        signal?: AbortSignal
    ): Promise<ChatAbortOutput> {
        await this.#touchSubscription(input.sessionKey);
        let cancellation;
        try {
            cancellation = await this.#repository.requestCancellation(
                input.runId,
                input.sessionKey
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
        if (!cancellation.shouldDispatch) {
            return v.parse(chatAbortOutputSchema, {
                aborted: cancellation.run.state === "cancelled",
                run: cancellation.run,
            });
        }
        if (this.#abortAcknowledgedRuns.has(input.runId)) {
            return v.parse(chatAbortOutputSchema, {
                aborted: cancellation.run.state === "cancelled",
                run: cancellation.run,
            });
        }
        const intent = this.#repository.readIntent(input.runId);
        if (intent === undefined) {
            throw new ChatServiceError("not-found");
        }
        if (!intent.dispatchAttempted) {
            const terminal = await this.#repository.appendEvents(input.runId, [
                {
                    kind: "terminal",
                    occurredAtMs: this.#nowMs(),
                    outcome: "aborted",
                },
            ]);
            return v.parse(chatAbortOutputSchema, {
                aborted: true,
                run: terminal.run,
            });
        }
        try {
            const acknowledgement = await this.#provider.abort(
                {
                    preserveSideRuns: false,
                    providerRunId:
                        intent.run.providerRunId ?? intent.request.idempotencyKey,
                    sessionKey: input.sessionKey,
                },
                signal
            );
            this.#abortAcknowledgedRuns.add(input.runId);
            // Both true and false acknowledgements are only point-in-time control
            // results. Provider completion/history remains authoritative.
            this.#startReconciliation(input.runId);
            return v.parse(chatAbortOutputSchema, {
                aborted: acknowledgement.aborted,
                run: this.#repository.findRun(input.runId) ?? cancellation.run,
            });
        } catch (error) {
            if (error instanceof ChatProviderUnknownOutcomeError) {
                await this.#repository.markOutcomeUnknown(input.runId);
                this.#abortAcknowledgedRuns.add(input.runId);
                this.#startReconciliation(input.runId);
                throw new ChatServiceError("unknown-outcome", {
                    cause: error,
                });
            }
            // A definitive transport rejection is safe to retry, while history
            // reconciliation prevents a durable cancel-requested row from stranding.
            this.#startReconciliation(input.runId);
            throw this.#serviceFailure(error);
        }
    }

    async #abortExternalOnce(
        input: ExternalChatAbortInput,
        signal?: AbortSignal
    ): Promise<ChatAbortOutput> {
        await this.#touchSubscription(input.sessionKey);
        await this.#flushExternalCoalescer(input.sessionKey);
        const externalRun = this.#externalRuns
            .get(input.sessionKey)
            ?.get(input.providerRunId);
        if (externalRun === undefined) {
            throw new ChatServiceError("not-found");
        }
        const previousBoundary = externalRun.abortBoundary;
        if (previousBoundary?.attemptId === input.abortAttemptId) {
            if (previousBoundary.settlement === "not-aborted") {
                return v.parse(chatAbortOutputSchema, {
                    aborted: false,
                    abortAttemptId: input.abortAttemptId,
                    providerRunId: input.providerRunId,
                });
            }
            throw new ChatServiceError("unknown-outcome");
        }
        if (
            previousBoundary !== undefined &&
            previousBoundary.settlement !== "not-aborted" &&
            (externalRun.observationEpoch <= previousBoundary.baselineObservationEpoch ||
                externalRun.observedAtMs <= previousBoundary.attemptedAtMs ||
                externalRun.updatedAtMs <= previousBoundary.baselineUpdatedAtMs)
        ) {
            throw new ChatServiceError("conflict");
        }
        const abortBoundary = {
            attemptId: input.abortAttemptId,
            attemptedAtMs: this.#nowMs(),
            baselineObservationEpoch: this.#externalObservationEpoch,
            baselineUpdatedAtMs: externalRun.updatedAtMs,
            settlement: "pending" as const,
        };
        this.#storeExternalRun(
            boundExternalRunProjection({
                ...externalRun,
                abortBoundary,
                updatedAtMs: this.#nextExternalSnapshotUpdatedAtMs(input.sessionKey),
            })
        );
        await this.#persistExternalRuntimeSnapshot(input.sessionKey);
        const currentBoundaryRun = (): ChatExternalRun | undefined => {
            const current = this.#externalRuns
                .get(input.sessionKey)
                ?.get(input.providerRunId);
            return current?.abortBoundary?.attemptId === input.abortAttemptId &&
                current.abortBoundary.attemptedAtMs === abortBoundary.attemptedAtMs &&
                current.abortBoundary.baselineObservationEpoch ===
                    abortBoundary.baselineObservationEpoch &&
                current.abortBoundary.baselineUpdatedAtMs ===
                    abortBoundary.baselineUpdatedAtMs
                ? current
                : undefined;
        };
        try {
            const acknowledgement = await this.#provider.abort(
                {
                    preserveSideRuns: false,
                    providerRunId: input.providerRunId,
                    sessionKey: input.sessionKey,
                },
                signal
            );
            const current = currentBoundaryRun();
            if (acknowledgement.aborted && current !== undefined) {
                const tombstoneUpdatedAtMs = this.#nextExternalSnapshotUpdatedAtMs(
                    input.sessionKey
                );
                this.#deleteExternalRun(input.sessionKey, input.providerRunId);
                await this.#persistExternalRuntimeSnapshot(
                    input.sessionKey,
                    true,
                    tombstoneUpdatedAtMs
                );
                if (!this.#externalRuns.has(input.sessionKey)) {
                    await this.#closeExternalCoalescer(input.sessionKey);
                }
            } else if (!acknowledgement.aborted && current !== undefined) {
                this.#storeExternalRun(
                    boundExternalRunProjection({
                        ...current,
                        abortBoundary: {
                            ...abortBoundary,
                            settlement: "not-aborted",
                        },
                        updatedAtMs: this.#nextExternalSnapshotUpdatedAtMs(
                            input.sessionKey
                        ),
                    })
                );
                await this.#persistExternalRuntimeSnapshot(input.sessionKey);
            }
            return v.parse(chatAbortOutputSchema, {
                aborted: acknowledgement.aborted,
                abortAttemptId: input.abortAttemptId,
                providerRunId: input.providerRunId,
            });
        } catch (error) {
            if (error instanceof ChatProviderUnknownOutcomeError) {
                const current = currentBoundaryRun();
                if (current !== undefined) {
                    this.#storeExternalRun(
                        boundExternalRunProjection({
                            ...current,
                            abortBoundary: {
                                ...abortBoundary,
                                settlement: "unknown",
                            },
                            updatedAtMs: this.#nextExternalSnapshotUpdatedAtMs(
                                input.sessionKey
                            ),
                        })
                    );
                    await this.#persistExternalRuntimeSnapshot(input.sessionKey);
                }
                throw new ChatServiceError("unknown-outcome", { cause: error });
            }
            const current = currentBoundaryRun();
            if (current !== undefined) {
                const { abortBoundary: _failedBoundary, ...withoutBoundary } = current;
                this.#storeExternalRun(
                    boundExternalRunProjection({
                        ...withoutBoundary,
                        updatedAtMs: this.#nextExternalSnapshotUpdatedAtMs(
                            input.sessionKey
                        ),
                    })
                );
                await this.#persistExternalRuntimeSnapshot(input.sessionKey);
            }
            throw this.#serviceFailure(error);
        }
    }

    public abort(
        rawInput: ChatAbortInput,
        signal?: AbortSignal
    ): Promise<ChatAbortOutput> {
        let input: ChatAbortInput;
        try {
            input = v.parse(chatAbortInputSchema, rawInput);
        } catch (error) {
            return Promise.reject(
                new ChatServiceError("invalid-input", { cause: error })
            );
        }
        const operationKey = JSON.stringify([
            "runId" in input ? "local" : "provider",
            "runId" in input ? input.runId : input.providerRunId,
            input.sessionKey,
        ]);
        const current = this.#abortOperations.get(operationKey);
        if (current !== undefined) {
            if (
                "providerRunId" in input &&
                current.abortAttemptId !== input.abortAttemptId
            ) {
                return Promise.reject(new ChatServiceError("conflict"));
            }
            return current.promise;
        }
        const operation =
            "runId" in input
                ? this.#abortOnce(input, signal)
                : this.#abortExternalOnce(input, signal);
        const trackedOperation: ChatAbortOperation = {
            ...("providerRunId" in input ? { abortAttemptId: input.abortAttemptId } : {}),
            promise: operation,
        };
        this.#abortOperations.set(operationKey, trackedOperation);
        const clearOperation = (): void => {
            if (this.#abortOperations.get(operationKey) === trackedOperation) {
                this.#abortOperations.delete(operationKey);
            }
        };
        void operation.then(clearOperation, clearOperation);
        return operation;
    }

    public async listModels(
        rawInput: ChatModelsListInput,
        signal?: AbortSignal
    ): Promise<ChatModelsListOutput> {
        const input = v.parse(chatModelsListInputSchema, rawInput);
        try {
            return v.parse(
                chatModelsListOutputSchema,
                await this.#provider.listModels(
                    {
                        agentId: input.agentId,
                        includeProviderCapabilities: true,
                        view: "all",
                    },
                    signal
                )
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async updateSessionSettings(
        rawInput: ChatSessionSettingsInput,
        signal?: AbortSignal
    ): Promise<ChatSessionSettingsOutput> {
        const input = v.parse(chatSessionSettingsInputSchema, rawInput);
        try {
            return v.parse(
                chatSessionSettingsOutputSchema,
                await this.#provider.updateSessionSettings(input, signal)
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async companionState(
        rawInput: ChatCompanionStateInput,
        signal?: AbortSignal
    ): Promise<ChatCompanionStateOutput> {
        const input = v.parse(chatCompanionStateInputSchema, rawInput);
        try {
            return v.parse(
                chatCompanionStateOutputSchema,
                await this.#provider.companionState(input, signal)
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    async #runCompanionAsk(
        input: ChatCompanionAskInput,
        generation: number,
        signal?: AbortSignal
    ): Promise<ChatCompanionAskOutput> {
        try {
            const output = v.parse(
                chatCompanionAskOutputSchema,
                await this.#provider.companionAsk(input, signal)
            );
            if (this.#companionGeneration(input.sessionKey) !== generation) {
                throw new ChatServiceError("conflict");
            }
            return output;
        } catch (error) {
            if (this.#companionGeneration(input.sessionKey) !== generation) {
                throw new ChatServiceError("conflict", { cause: error });
            }
            throw this.#serviceFailure(error);
        }
    }

    #companionActorKey(actor: ChatAdmissionActor): string {
        return `${actor.kind}:${actor.id}`;
    }

    #admitCompanionRate(actor: ChatAdmissionActor): void {
        const now = this.#nowMs();
        const cutoff = now - chatCompanionAskRateWindowMilliseconds;
        for (const [actorKey, timestamps] of this.#companionRateWindows) {
            const retained = timestamps.filter((timestamp) => timestamp > cutoff);
            if (retained.length === 0) {
                this.#companionRateWindows.delete(actorKey);
            } else if (retained.length !== timestamps.length) {
                this.#companionRateWindows.set(actorKey, retained);
            }
        }
        const actorKey = this.#companionActorKey(actor);
        const timestamps = this.#companionRateWindows.get(actorKey) ?? [];
        if (
            timestamps.length >= chatCompanionAskActorWindowMaximum ||
            (timestamps.length === 0 &&
                this.#companionRateWindows.size >= chatCompanionRateActorMaximum)
        ) {
            throw new ChatServiceError("capacity");
        }
        this.#companionRateWindows.set(actorKey, [...timestamps, now]);
    }

    #releaseCompanionAsk(sessionKey: string, admission: ChatCompanionAskAdmission): void {
        if (admission.released) return;
        admission.released = true;
        this.#companionAskCount -= 1;
        if (this.#companionAsks.get(sessionKey) === admission) {
            this.#companionAsks.delete(sessionKey);
        }
    }

    public companionAsk(
        rawInput: ChatCompanionAskInput,
        actor: ChatAdmissionActor,
        signal?: AbortSignal
    ): Promise<ChatCompanionAskOutput> {
        const input = v.parse(chatCompanionAskInputSchema, rawInput);
        if (
            this.#disposed ||
            this.#companionAsks.has(input.sessionKey) ||
            this.#companionResets.has(input.sessionKey) ||
            this.#companionAskCount >= chatCompanionAskProcessMaximum
        ) {
            return Promise.reject(new ChatServiceError("capacity"));
        }
        try {
            this.#admitCompanionRate(actor);
        } catch (error) {
            return Promise.reject(this.#serviceFailure(error));
        }
        this.#companionAskCount += 1;
        const controller = new AbortController();
        const generation = this.#companionGeneration(input.sessionKey);
        const combinedSignal =
            signal === undefined
                ? controller.signal
                : AbortSignal.any([signal, controller.signal]);
        const operation = this.#runCompanionAsk(input, generation, combinedSignal);
        const admission: ChatCompanionAskAdmission = {
            controller,
            generation,
            promise: operation,
            released: false,
        };
        this.#companionAsks.set(input.sessionKey, admission);
        const release = (): undefined => {
            this.#releaseCompanionAsk(input.sessionKey, admission);
            return undefined;
        };
        void operation.then(release, release);
        return operation;
    }

    async #runCompanionReset(
        input: ChatCompanionResetInput,
        signal?: AbortSignal
    ): Promise<ChatCompanionResetOutput> {
        if (this.#disposed) throw new ChatServiceError("provider-unavailable");
        try {
            return v.parse(
                chatCompanionResetOutputSchema,
                await this.#provider.companionReset(input, signal)
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public companionReset(
        rawInput: ChatCompanionResetInput,
        signal?: AbortSignal
    ): Promise<ChatCompanionResetOutput> {
        const input = v.parse(chatCompanionResetInputSchema, rawInput);
        const current = this.#companionResets.get(input.sessionKey);
        if (current !== undefined) return current;
        if (this.#disposed) {
            return Promise.reject(new ChatServiceError("provider-unavailable"));
        }
        const operation = this.#runCompanionReset(input, signal);
        this.#companionResets.set(input.sessionKey, operation);
        const releaseReset = (): undefined => {
            if (this.#companionResets.get(input.sessionKey) === operation) {
                this.#companionResets.delete(input.sessionKey);
            }
            return undefined;
        };
        void operation.then(() => {
            this.#invalidateCompanionGeneration(input.sessionKey);
            return releaseReset();
        }, releaseReset);
        return operation;
    }

    async #recoverTranscriptFences(signal?: AbortSignal): Promise<void> {
        for (const transcript of this.#repository.listReconcilingTranscripts()) {
            signal?.throwIfAborted();
            const candidates = this.#repository.listTranscriptRecoveryCandidates(
                transcript.sessionKey
            );
            let history: Readonly<{
                inFlightRun?: ChatProviderInFlightRun;
                messages: readonly ChatMessage[];
                sessionId?: string;
            }>;
            try {
                history = await this.#readReconciliationHistory(
                    transcript.sessionKey,
                    signal
                );
            } catch (error) {
                this.#reportAsyncFailure(error);
                continue;
            }
            const represented =
                candidates.length > 0 &&
                candidates.every((candidate) => {
                    if (!candidate.dispatchAttempted) return false;
                    const final = findFinalHistoryMessage(
                        history.messages,
                        candidate.run.id,
                        candidate.run.providerRunId,
                        candidate.request.idempotencyKey
                    );
                    const inFlight = history.inFlightRun;
                    return (
                        final ||
                        (inFlight !== undefined &&
                            (inFlight.runId === candidate.run.providerRunId ||
                                inFlight.runId === candidate.request.idempotencyKey))
                    );
                });
            const observedAtMs = this.#nowMs();
            let providerUpdatedAtMs = 0;
            for (const message of history.messages) {
                providerUpdatedAtMs = Math.max(
                    providerUpdatedAtMs,
                    message.createdAtMs ?? 0
                );
            }
            const input = {
                ...(history.sessionId === undefined
                    ? {}
                    : { providerSessionId: history.sessionId }),
                ...(providerUpdatedAtMs === 0 ? {} : { providerUpdatedAtMs }),
                represented,
                sessionKey: transcript.sessionKey,
                observedAtMs,
            };
            await (this.#transcriptLifecycle === undefined
                ? this.#repository.reconcileTranscript(input)
                : this.#transcriptLifecycle.reconcile(input));
        }
    }

    async #reconcileExternalSnapshotSession(
        sessionKey: string,
        signal?: AbortSignal
    ): Promise<void> {
        const observation = this.#beginExternalObservation(this.#nowMs());
        const activeProviderRunIds = await this.#activeProviderRunIds?.(
            sessionKey,
            signal
        );
        if (activeProviderRunIds !== undefined) {
            await this.#observeActiveProviderRunIds(
                sessionKey,
                activeProviderRunIds,
                observation
            );
        }
        const history = await this.#readReconciliationHistory(sessionKey, signal);
        await this.observeInFlightRun(sessionKey, history.inFlightRun, observation);
        await this.observeHistoryMessages(sessionKey, history.messages, observation);
    }

    async #observeActiveProviderRunIds(
        sessionKey: string,
        activeProviderRunIds: readonly string[],
        observation: ChatProviderObservationBoundary
    ): Promise<void> {
        const runs = this.#externalRuns.get(sessionKey);
        if (runs === undefined) return;
        const active = new Set(activeProviderRunIds);
        let changed = false;
        for (const [providerRunId, run] of runs) {
            if (
                run.lifecycle !== "active" ||
                active.has(providerRunId) ||
                !externalObservationIsCurrentOrNewer(run, observation)
            ) {
                continue;
            }
            this.#storeExternalRun(
                boundExternalRunProjection({
                    ...run,
                    lifecycle: "terminal-pending-history",
                    observationEpoch: Math.max(run.observationEpoch, observation.epoch),
                    observedAtMs: Math.max(run.observedAtMs, observation.observedAtMs),
                    updatedAtMs: this.#nextExternalSnapshotUpdatedAtMs(sessionKey),
                })
            );
            changed = true;
        }
        if (!changed) return;
        await this.#flushExternalCoalescer(sessionKey);
        await this.#persistExternalRuntimeSnapshot(sessionKey);
    }

    /**
     * Reconciles one provider-owned session after Gateway accepts an external
     * send or steer. The provider history remains authoritative; callers supply
     * only the already validated session identity, never message payloads.
     * @param sessionKey Canonical Gateway session identity.
     * @param signal Optional cancellation for the bounded provider read.
     */
    public async reconcileProviderSessionActivity(
        sessionKey: string,
        signal?: AbortSignal
    ): Promise<void> {
        if (this.#disposed) throw new ChatServiceError("provider-unavailable");
        try {
            await this.#watchSession(sessionKey, false);
            await this.#reconcileExternalSnapshotSession(sessionKey, signal);
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async observeProviderUserMessage(
        message: Readonly<{
            attachments?: readonly Extract<ChatMessagePart, { kind: "attachment" }>[];
            messageId: string;
            providerRunIds: readonly string[];
            receivedAtMs: number;
            sessionKey: string;
            text: string;
        }>
    ): Promise<void> {
        if (this.#disposed) throw new ChatServiceError("provider-unavailable");
        try {
            const providerRunId =
                [...(this.#externalRuns.get(message.sessionKey)?.values() ?? [])]
                    .filter(
                        (run) =>
                            run.lifecycle === "active" &&
                            run.source === "provider-runtime" &&
                            message.providerRunIds.includes(run.providerRunId)
                    )
                    .toSorted(compareExternalRuns)
                    .at(-1)?.providerRunId ?? message.providerRunIds.at(-1);
            if (providerRunId === undefined) return;
            await this.#handleProviderUserEvent(
                {
                    ...(message.attachments === undefined
                        ? {}
                        : { attachments: message.attachments }),
                    idempotencyKey: message.messageId,
                    kind: "user",
                    providerRunId,
                    receivedAtMs: message.receivedAtMs,
                    sessionKey: message.sessionKey,
                    text: message.text,
                },
                this.#beginExternalObservation(message.receivedAtMs),
                false
            );
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }

    public async recover(signal?: AbortSignal): Promise<void> {
        await this.#recoverTranscriptFences(signal);
        const firstDirtySession = this.#externalDirtySessions.values().next().value;
        if (firstDirtySession !== undefined) {
            await this.#persistExternalRuntimeSnapshot(firstDirtySession);
        }
        const candidates = this.#repository.listRecoveryCandidates();
        const externalSessionKeys = [...this.#externalRuns.keys()];
        const watchedSessionKeys = [
            ...new Set([
                ...externalSessionKeys,
                ...candidates.map(({ run }) => run.sessionKey),
                ...this.#repository.listKnownSessionKeys(this.#subscriptionMaximum),
            ]),
        ].slice(0, this.#subscriptionMaximum);
        for (const sessionKey of watchedSessionKeys) {
            await this.#watchSession(sessionKey, false);
        }
        for (const sessionKey of externalSessionKeys) {
            await this.#reconcileExternalSnapshotSession(sessionKey, signal);
        }
        for (const candidate of candidates) {
            if (!candidate.dispatchAttempted) {
                await this.#terminalFailure(
                    candidate.run.id,
                    "recovery_before_dispatch",
                    "Chat run could not safely resume before provider dispatch"
                );
                continue;
            }
            if (
                this.#nowMs() >=
                candidate.run.admittedAtMs + reconciliationLifecycleMilliseconds
            ) {
                await this.#settleReconciliationDeadline(candidate.run.id);
                continue;
            }
            const complete = await this.#reconcileSingleFlight(candidate.run.id);
            if (!complete && signal?.aborted !== true) {
                this.#startReconciliation(candidate.run.id);
            }
        }
    }

    public sweepSubscriptions(atMs?: number): Promise<number> {
        return this.#subscriptions.sweep(atMs);
    }

    public async sweepRetention(at?: Date): Promise<number> {
        let removed = 0;
        for (let batch = 0; batch < chatRetentionSweepMaximumBatches; batch += 1) {
            const count = await this.#repository.pruneExpired(
                at,
                chatRetentionSweepBatchSize
            );
            removed += count;
            if (count < chatRetentionSweepBatchSize) break;
        }
        return removed;
    }

    public async dispose(): Promise<void> {
        if (this.#disposed) return;
        this.#disposed = true;
        this.#unsubscribeTranscriptLifecycle?.();
        for (const handle of this.#reconciliationTimers.values()) {
            this.#recoveryScheduler.clear(handle);
        }
        this.#reconciliationTimers.clear();
        await Promise.all(
            [...this.#coalescers.values()].map((coalescer) =>
                coalescer.close().catch((error: unknown) => {
                    this.#reportAsyncFailure(error);
                })
            )
        );
        this.#coalescers.clear();
        await Promise.all(
            [...this.#externalCoalescers.values()].map((coalescer) =>
                coalescer.close().catch((error: unknown) => {
                    this.#reportAsyncFailure(error);
                })
            )
        );
        this.#externalCoalescers.clear();
        for (const sessionKey of new Set([
            ...this.#externalRuns.keys(),
            ...this.#externalDirtySessions,
        ])) {
            await this.#persistExternalRuntimeSnapshot(sessionKey);
        }
        for (const [localRunId, pending] of this.#pendingReservations) {
            if (pending.settlement === "hold") continue;
            await this.#settleReservation(localRunId, pending.settlement);
        }
        this.#pendingReservations.clear();
        this.#companionRateWindows.clear();
        for (const admission of this.#companionAsks.values()) {
            admission.controller.abort();
        }
        this.#companionAsks.clear();
        this.#companionAskCount = 0;
        this.#companionGenerations.clear();
        this.#backgroundWatchedSessions.clear();
        this.#externalRuns.clear();
        this.#externalObservationKinds.clear();
        this.#externalCapacityReductionSessions.clear();
        this.#externalDirtySessions.clear();
        this.#externalTruncatedSessions.clear();
        await this.#subscriptions.dispose();
    }

    #serviceFailure(error: unknown): ChatServiceError {
        if (error instanceof ChatServiceError) return error;
        if (error instanceof v.ValiError) {
            return new ChatServiceError("invalid-input", { cause: error });
        }
        if (error instanceof ChatAttachmentTicketError) {
            if (error.reason === "capacity") {
                return new ChatServiceError("capacity", { cause: error });
            }
            if (error.reason === "unavailable") {
                return new ChatServiceError("provider-unavailable", { cause: error });
            }
            return new ChatServiceError("invalid-input", { cause: error });
        }
        if (
            error instanceof ChatAdmissionCapacityError ||
            error instanceof ChatProviderCapacityError ||
            error instanceof ChatSubscriptionCapacityError
        ) {
            return new ChatServiceError("capacity", { cause: error });
        }
        if (
            error instanceof ChatAdmissionConflictError ||
            error instanceof ChatProviderConflictError ||
            error instanceof ChatProviderSequenceConflictError ||
            error instanceof ChatProviderSequenceGapError ||
            error instanceof ChatRunTransitionError ||
            error instanceof ChatTranscriptUnavailableError
        ) {
            return new ChatServiceError("conflict", { cause: error });
        }
        if (
            error instanceof ChatRunNotFoundError ||
            error instanceof ChatProviderNotFoundError
        ) {
            return new ChatServiceError("not-found", { cause: error });
        }
        if (error instanceof ChatProviderUnknownOutcomeError) {
            return new ChatServiceError("unknown-outcome", { cause: error });
        }
        if (error instanceof ChatProviderUnavailableError) {
            return new ChatServiceError("provider-unavailable", { cause: error });
        }
        return new ChatServiceError("provider-unavailable", { cause: error });
    }

    #hasRuntimeSubscriptionPin(sessionKey: string): boolean {
        return (
            this.#repository.listProviderRunWatermarks(sessionKey).length > 0 ||
            (this.#externalRuns.get(sessionKey)?.size ?? 0) > 0
        );
    }

    async #watchSession(sessionKey: string, remember: boolean): Promise<void> {
        if (remember) await this.#repository.rememberSession(sessionKey);
        const alreadyWatched = this.#backgroundWatchedSessions.delete(sessionKey);
        if (
            !alreadyWatched &&
            this.#backgroundWatchedSessions.size >= this.#subscriptionMaximum
        ) {
            const evictedSessionKey = [...this.#backgroundWatchedSessions].find(
                (candidate) => !this.#hasRuntimeSubscriptionPin(candidate)
            );
            if (evictedSessionKey === undefined) {
                throw new ChatSubscriptionCapacityError();
            }
            this.#backgroundWatchedSessions.delete(evictedSessionKey);
            await this.#subscriptions.releaseIfUnpinned(evictedSessionKey);
        }
        this.#backgroundWatchedSessions.add(sessionKey);
        try {
            await this.#subscriptions.touch(sessionKey);
        } catch (error) {
            if (!alreadyWatched) this.#backgroundWatchedSessions.delete(sessionKey);
            throw error;
        }
    }

    async #touchSubscription(sessionKey: string): Promise<void> {
        try {
            await this.#watchSession(sessionKey, true);
        } catch (error) {
            throw this.#serviceFailure(error);
        }
    }
}

export function createChatService(options: ChatServiceOptions): ChatService {
    return new ChatServiceImplementation(options);
}
