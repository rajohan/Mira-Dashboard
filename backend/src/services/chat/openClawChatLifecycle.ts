import type { OpenClawRuntimeEnvelope } from "../../../../contracts/chat.ts";
import {
    asRecord,
    runtimePayloadView,
    runtimeSessionId,
    safeNumberField,
    sessionMessageRole,
    sessionMessageStopReason,
    stringField,
} from "./openClawChatProviderAdapter.ts";

export interface RuntimeSessionInstance {
    id: string;
    startedAt: number;
}

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

/**
 * Detects the first event from a new provider runtime session instance.
 * @param envelope Canonical runtime envelope.
 * @returns Runtime session boundary when the event starts a provider session.
 */
export function runtimeSessionBoundary(
    envelope: OpenClawRuntimeEnvelope
): RuntimeSessionInstance | undefined {
    const sessionId = runtimeSessionId(envelope.payload);
    const payloadView = runtimePayloadView(envelope.payload);
    if (!sessionId || !payloadView) {
        return undefined;
    }

    const stream = (stringField(payloadView, "stream") || "").toLowerCase();
    const phase = (stringField(payloadView, "phase") || "").toLowerCase();
    const isLifecycleStart =
        envelope.event === "agent" && stream === "lifecycle" && phase === "start";
    const isSessionStart = envelope.event === "session.started";
    const isInitialUserMessage =
        envelope.event === "session.message" &&
        sessionMessageRole(envelope.payload) === "user" &&
        safeNumberField(payloadView, "messageSeq") === 1;
    if (!isLifecycleStart && !isSessionStart && !isInitialUserMessage) {
        return undefined;
    }

    return {
        id: sessionId,
        startedAt:
            safeNumberField(payloadView, "startedAt") ||
            safeNumberField(payloadView, "ts") ||
            envelope.runtimeRecordedAt,
    };
}

export function isAgentCompactionEvent(event: unknown, payload: unknown): boolean {
    const record = asRecord(payload);
    const data = asRecord(record?.data);
    const stream = stringField(data, "stream") || stringField(record, "stream");
    return event === "agent" && stream?.toLowerCase() === "compaction";
}

export function isCompactionEvent(event: unknown, payload: unknown): boolean {
    return event === "session.compaction" || isAgentCompactionEvent(event, payload);
}

export function isSettlingLifecycleEvent(event: unknown, payload: unknown): boolean {
    const record = runtimePayloadView(payload);
    const stream = (stringField(record, "stream") || "").toLowerCase();
    const phase = (stringField(record, "phase") || "").toLowerCase();
    return (
        event === "agent" && stream === "lifecycle" && ["end", "error"].includes(phase)
    );
}

export function isSuccessfulLifecycleSettlementEvent(
    event: unknown,
    payload: unknown
): boolean {
    const record = runtimePayloadView(payload);
    const stream = (stringField(record, "stream") || "").toLowerCase();
    const phase = (stringField(record, "phase") || "").toLowerCase();
    const status = (stringField(record, "status") || "").toLowerCase();
    const explicitError =
        stringField(record, "errorMessage") ||
        stringField(record, "promptError") ||
        stringField(record, "error");
    const isFailed =
        Boolean(explicitError) ||
        record?.aborted === true ||
        TERMINAL_FAILURE_STATES.has(status);
    return event === "agent" && stream === "lifecycle" && phase === "end" && !isFailed;
}

/**
 * Identifies provider work that can continue one interrupted conversation.
 * @param event Provider event name.
 * @param payload Provider event payload.
 * @returns Whether the event can continue interrupted conversational work.
 */
export function isConversationContinuationEvent(
    event: unknown,
    payload: unknown
): boolean {
    return !(
        isCompactionEvent(event, payload) ||
        (event === "session.message" && sessionMessageRole(payload) === "user")
    );
}

export function isTerminalEvent(event: unknown, payload: unknown): boolean {
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

export function isMetadataOnlyCompletionEnvelope(
    envelope: OpenClawRuntimeEnvelope
): boolean {
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
