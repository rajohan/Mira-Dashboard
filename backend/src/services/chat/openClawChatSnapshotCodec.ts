import {
    OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    parseOpenClawRuntimeEnvelope,
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "../../../../contracts/chat.ts";
import { MAX_OPENCLAW_PENDING_REQUEST_BOUNDARIES } from "./openClawChatRequestBoundaries.ts";

export interface SnapshotEventRow {
    envelope_json: string;
    runtime_sequence: number;
}

export interface ParsedStoredSnapshot {
    eventFingerprints: StoredEventFingerprint[];
    runSignature: string[];
    snapshot: OpenClawRuntimeSnapshot;
}

interface StoredEventFingerprint {
    fingerprint: string;
    runtimeSequence: number;
}

export interface SerializedSnapshotEvent extends StoredEventFingerprint {
    envelope: OpenClawRuntimeEnvelope;
    envelopeJson?: string;
}

export const EVENT_ROW_STORAGE = "rows-v2";
const SHA256_PATTERN = /^[a-f\d]{64}$/u;

export function hasReplay(snapshot: OpenClawRuntimeSnapshot): boolean {
    return snapshot.events.length > 0;
}

export function normalizedSessionKey(sessionKey: string): string {
    const normalized = sessionKey.trim().toLowerCase();
    if (!normalized) {
        throw new Error("Session key is required for chat runtime persistence");
    }
    return normalized;
}

function isRuntimeEnvelope(value: unknown): value is OpenClawRuntimeEnvelope {
    try {
        parseOpenClawRuntimeEnvelope(value, "storedRuntimeEvent");
        return true;
    } catch {
        return false;
    }
}

export function eventFingerprint(envelopeJson: string): string {
    return new Bun.CryptoHasher("sha256").update(envelopeJson).digest("hex");
}

function isStoredEventFingerprint(value: unknown): value is StoredEventFingerprint {
    const fingerprint = asRecord(value);
    return Boolean(
        fingerprint &&
        Number.isSafeInteger(fingerprint.runtimeSequence) &&
        (fingerprint.runtimeSequence as number) >= 0 &&
        typeof fingerprint.fingerprint === "string" &&
        SHA256_PATTERN.test(fingerprint.fingerprint)
    );
}

function isInterruptedAtByRun(value: unknown): value is Record<string, number> {
    const record = asRecord(value);
    return Boolean(
        record &&
        Object.entries(record).every(
            ([runId, interruptedAt]) =>
                runId.trim().length > 0 &&
                Number.isSafeInteger(interruptedAt) &&
                (interruptedAt as number) >= 0
        )
    );
}

function isFirstSequenceByRun(
    value: unknown,
    throughSequence: number
): value is Record<string, number> {
    const record = asRecord(value);
    return Boolean(
        record &&
        Object.entries(record).every(
            ([runId, firstSequence]) =>
                runId.trim().length > 0 &&
                Number.isSafeInteger(firstSequence) &&
                (firstSequence as number) >= 0 &&
                (firstSequence as number) <= throughSequence
        )
    );
}

function isRequestBoundaryRecord(
    value: unknown,
    throughSequence: number
): value is Record<string, number> {
    const record = asRecord(value);
    return Boolean(
        record &&
        Object.keys(record).length <= MAX_OPENCLAW_PENDING_REQUEST_BOUNDARIES &&
        Object.entries(record).every(
            ([requestId, boundary]) =>
                requestId.trim().length > 0 &&
                Number.isSafeInteger(boundary) &&
                (boundary as number) >= 0 &&
                (boundary as number) <= throughSequence
        )
    );
}

export function parseStoredSnapshot(
    serialized: string
): ParsedStoredSnapshot | undefined {
    try {
        const value = JSON.parse(serialized) as Record<string, unknown>;
        const events = Array.isArray(value.events) ? value.events : [];
        const eventFingerprints = Array.isArray(value.eventFingerprints)
            ? value.eventFingerprints.filter(isStoredEventFingerprint)
            : [];
        const throughSequence = value.throughSequence;
        const acknowledgedRequestIds = value.acknowledgedRequestIds;
        const firstSequenceByRun = value.firstSequenceByRun;
        const interruptedAtByRun = value.interruptedAtByRun;
        const pendingRequestBoundaries = value.pendingRequestBoundaries;
        const requestBoundary = value.requestBoundary;
        const schemaVersion = value.schemaVersion;
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.completed !== "boolean" ||
            !Array.isArray(value.events) ||
            events.length > 0 ||
            !Array.isArray(value.eventFingerprints) ||
            eventFingerprints.length !== value.eventFingerprints.length ||
            !Number.isSafeInteger(throughSequence) ||
            (throughSequence as number) < 0 ||
            schemaVersion !== OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION ||
            (interruptedAtByRun !== undefined &&
                !isInterruptedAtByRun(interruptedAtByRun)) ||
            value.eventStorage !== EVENT_ROW_STORAGE ||
            eventFingerprints.some(
                (event, index) =>
                    event.runtimeSequence > (throughSequence as number) ||
                    (index > 0 &&
                        event.runtimeSequence <=
                            eventFingerprints[index - 1]!.runtimeSequence)
            )
        ) {
            return undefined;
        }
        if (
            acknowledgedRequestIds !== undefined &&
            (!Array.isArray(acknowledgedRequestIds) ||
                acknowledgedRequestIds.length > MAX_OPENCLAW_PENDING_REQUEST_BOUNDARIES ||
                acknowledgedRequestIds.some(
                    (requestId) =>
                        typeof requestId !== "string" || requestId.trim().length === 0
                ))
        ) {
            delete value.acknowledgedRequestIds;
        }
        if (
            firstSequenceByRun !== undefined &&
            !isFirstSequenceByRun(firstSequenceByRun, throughSequence as number)
        ) {
            delete value.firstSequenceByRun;
        }
        if (
            pendingRequestBoundaries !== undefined &&
            !isRequestBoundaryRecord(pendingRequestBoundaries, throughSequence as number)
        ) {
            delete value.pendingRequestBoundaries;
        }
        if (
            requestBoundary !== undefined &&
            (!Number.isSafeInteger(requestBoundary) ||
                (requestBoundary as number) < 0 ||
                (requestBoundary as number) > (throughSequence as number))
        ) {
            delete value.requestBoundary;
        }
        if (Array.isArray(value.acknowledgedRequestIds)) {
            const validPendingRequestIds = new Set(
                Object.keys(asRecord(value.pendingRequestBoundaries) || {})
            );
            const normalizedAcknowledgedRequestIds = [
                ...new Set(
                    value.acknowledgedRequestIds.filter(
                        (requestId): requestId is string =>
                            typeof requestId === "string" &&
                            validPendingRequestIds.has(requestId)
                    )
                ),
            ];
            if (normalizedAcknowledgedRequestIds.length === 0) {
                delete value.acknowledgedRequestIds;
            } else {
                value.acknowledgedRequestIds = normalizedAcknowledgedRequestIds;
            }
        }
        const runSignature = Array.isArray(value.runSignature)
            ? value.runSignature.filter(
                  (runId): runId is string =>
                      typeof runId === "string" && runId.length > 0
              )
            : [];
        if (
            !Array.isArray(value.runSignature) ||
            runSignature.length !== value.runSignature.length
        ) {
            return undefined;
        }
        return {
            eventFingerprints,
            runSignature,
            snapshot: value as unknown as OpenClawRuntimeSnapshot,
        };
    } catch {
        return undefined;
    }
}

export function parseStoredEvent(
    row: SnapshotEventRow,
    throughSequence: number
): OpenClawRuntimeEnvelope | undefined {
    try {
        const envelope = JSON.parse(row.envelope_json) as unknown;
        return isRuntimeEnvelope(envelope) &&
            envelope.runtimeSequence === row.runtime_sequence &&
            envelope.runtimeSequence <= throughSequence
            ? envelope
            : undefined;
    } catch {
        return undefined;
    }
}

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

export function snapshotRunSignature(snapshot: OpenClawRuntimeSnapshot): string[] {
    const runIds = new Set<string>();
    for (const envelope of snapshot.events) {
        const payload = asRecord(envelope.payload);
        const data = asRecord(payload?.data);
        const runId = stringField(data, "runId") || stringField(payload, "runId");
        if (runId) {
            runIds.add(runId);
        }
    }
    if (runIds.size > 0) {
        return runIds
            .values()
            .toArray()
            .toSorted((left, right) => left.localeCompare(right));
    }
    const firstSequence = snapshot.events[0]?.runtimeSequence;
    return firstSequence === undefined ? [] : [`sequence:${firstSequence}`];
}

export function hasSameRunSignature(left: string[], right: string[]): boolean {
    return (
        left.length === right.length &&
        left.every((runId, index) => runId === right[index])
    );
}

export function snapshotMetadata(
    snapshot: OpenClawRuntimeSnapshot,
    runSignature: string[],
    events: readonly SerializedSnapshotEvent[]
): Record<string, unknown> {
    return {
        ...(snapshot.acknowledgedRequestIds && {
            acknowledgedRequestIds: snapshot.acknowledgedRequestIds,
        }),
        completed: snapshot.completed,
        eventFingerprints: events.map(({ fingerprint, runtimeSequence }) => ({
            fingerprint,
            runtimeSequence,
        })),
        eventStorage: EVENT_ROW_STORAGE,
        events: [],
        ...(snapshot.firstSequenceByRun && {
            firstSequenceByRun: snapshot.firstSequenceByRun,
        }),
        ...(snapshot.interruptedAtByRun && {
            interruptedAtByRun: snapshot.interruptedAtByRun,
        }),
        ...(snapshot.pendingRequestBoundaries && {
            pendingRequestBoundaries: snapshot.pendingRequestBoundaries,
        }),
        ...(snapshot.requestBoundary !== undefined && {
            requestBoundary: snapshot.requestBoundary,
        }),
        runSignature,
        schemaVersion: OPENCLAW_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
        throughSequence: snapshot.throughSequence,
    };
}
