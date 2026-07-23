import { createHash } from "node:crypto";

import { database } from "../database.ts";
import {
    MAX_CHAT_RUNTIME_SESSIONS,
    type OpenClawChatSnapshotStore,
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "./openClawChatBridge.ts";
import { MAX_OPENCLAW_PENDING_REQUEST_BOUNDARIES } from "./openClawChatRequestBoundaries.ts";

interface SnapshotRow {
    snapshot_json: string;
}

interface SnapshotEventRow {
    envelope_json: string;
    runtime_sequence: number;
}

interface SnapshotKeyRow {
    session_key: string;
}

interface SnapshotMaximumSequenceRow {
    maximum_sequence: unknown;
}

interface ParsedStoredSnapshot {
    eventFingerprints: StoredEventFingerprint[];
    runSignature: string[];
    snapshot: OpenClawRuntimeSnapshot;
}

interface StoredEventFingerprint {
    fingerprint: string;
    runtimeSequence: number;
}

interface SerializedSnapshotEvent extends StoredEventFingerprint {
    envelope: OpenClawRuntimeEnvelope;
    envelopeJson?: string;
}

const EVENT_ROW_STORAGE = "rows-v2";
const SHA256_PATTERN = /^[a-f\d]{64}$/u;

function hasReplay(snapshot: OpenClawRuntimeSnapshot): boolean {
    return snapshot.events.length > 0;
}

const SAVE_SNAPSHOT_SQL = `
    INSERT INTO chat_runtime_snapshots (
        gateway_scope,
        session_key,
        snapshot_json,
        updated_at
    ) VALUES (?, ?, ?, ?)
`;

const SAVE_SNAPSHOT_EVENT_SQL = `
    INSERT OR REPLACE INTO chat_runtime_snapshot_events (
        gateway_scope,
        session_key,
        runtime_sequence,
        envelope_json
    ) VALUES (?, ?, ?, ?)
`;

const PRUNE_SNAPSHOTS_SQL = `
    DELETE FROM chat_runtime_snapshots
    WHERE gateway_scope = ?
      AND rowid NOT IN (
          SELECT rowid
          FROM chat_runtime_snapshots
          WHERE gateway_scope = ?
          ORDER BY updated_at DESC, rowid DESC
          LIMIT ?
      )
`;

const PRUNE_SNAPSHOT_EVENTS_SQL = `
    DELETE FROM chat_runtime_snapshot_events AS events
    WHERE events.gateway_scope = ?
      AND NOT EXISTS (
          SELECT 1
          FROM chat_runtime_snapshots AS snapshots
          WHERE snapshots.gateway_scope = events.gateway_scope
            AND lower(trim(snapshots.session_key)) = lower(trim(events.session_key))
      )
`;

function normalizedSessionKey(sessionKey: string): string {
    const normalized = sessionKey.trim().toLowerCase();
    if (!normalized) {
        throw new Error("Session key is required for chat runtime persistence");
    }
    return normalized;
}

function isRuntimeEnvelope(value: unknown): value is OpenClawRuntimeEnvelope {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const envelope = value as Record<string, unknown>;
    return (
        envelope.type === "event" &&
        Number.isFinite(envelope.runtimeRecordedAt) &&
        Number.isSafeInteger(envelope.runtimeSequence) &&
        (envelope.runtimeSequence as number) >= 0
    );
}

function eventFingerprint(envelopeJson: string): string {
    return createHash("sha256").update(envelopeJson).digest("hex");
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

function parseStoredSnapshot(serialized: string): ParsedStoredSnapshot | undefined {
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

function parseStoredEvent(
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

function snapshotRunSignature(snapshot: OpenClawRuntimeSnapshot): string[] {
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

function hasSameRunSignature(left: string[], right: string[]): boolean {
    return (
        left.length === right.length &&
        left.every((runId, index) => runId === right[index])
    );
}

function snapshotMetadata(
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
        throughSequence: snapshot.throughSequence,
    };
}

/** Persists runtime replay incrementally without exposing its payload as a new API. */
export class SqliteOpenClawChatSnapshotStore implements OpenClawChatSnapshotStore {
    readonly #eventFingerprints = new WeakMap<OpenClawRuntimeEnvelope, string>();
    readonly #gatewayScope: string;
    readonly #now: () => string;

    constructor(
        gatewayScope: string,
        now: () => string = () => new Date().toISOString()
    ) {
        const normalizedScope = gatewayScope.trim();
        if (!normalizedScope) {
            throw new Error("Gateway scope is required for chat runtime persistence");
        }
        this.#gatewayScope = normalizedScope;
        this.#now = now;
    }

    #insertSnapshotMetadata(
        sessionKey: string,
        snapshot: OpenClawRuntimeSnapshot,
        runSignature: string[],
        events: readonly SerializedSnapshotEvent[],
        updatedAt: string
    ): void {
        database
            .prepare(SAVE_SNAPSHOT_SQL)
            .run(
                this.#gatewayScope,
                sessionKey,
                JSON.stringify(snapshotMetadata(snapshot, runSignature, events)),
                updatedAt
            );
    }

    #deleteEventRows(sessionKey: string): void {
        database
            .prepare(
                `DELETE FROM chat_runtime_snapshot_events
                 WHERE gateway_scope = ? AND session_key = ?`
            )
            .run(this.#gatewayScope, sessionKey);
    }

    #insertEventRows(
        sessionKey: string,
        events: readonly SerializedSnapshotEvent[]
    ): void {
        const insert = database.prepare(SAVE_SNAPSHOT_EVENT_SQL);
        for (const event of events) {
            insert.run(
                this.#gatewayScope,
                sessionKey,
                event.runtimeSequence,
                event.envelopeJson || JSON.stringify(event.envelope)
            );
        }
    }

    #serializeEvents(
        events: readonly OpenClawRuntimeEnvelope[]
    ): SerializedSnapshotEvent[] {
        return events.map((envelope) => {
            const cachedFingerprint = this.#eventFingerprints.get(envelope);
            if (cachedFingerprint) {
                return {
                    envelope,
                    fingerprint: cachedFingerprint,
                    runtimeSequence: envelope.runtimeSequence,
                };
            }
            const envelopeJson = JSON.stringify(envelope);
            const fingerprint = eventFingerprint(envelopeJson);
            this.#eventFingerprints.set(envelope, fingerprint);
            return {
                envelope,
                envelopeJson,
                fingerprint,
                runtimeSequence: envelope.runtimeSequence,
            };
        });
    }

    #persistSnapshot(
        sessionKey: string,
        snapshot: OpenClawRuntimeSnapshot,
        updatedAt: string,
        shouldReplace = false
    ): void {
        const existingRow = database
            .prepare(
                `SELECT snapshot_json
                 FROM chat_runtime_snapshots
                 WHERE gateway_scope = ? AND session_key = ?`
            )
            .get(this.#gatewayScope, sessionKey) as SnapshotRow | undefined;
        const existing = existingRow
            ? parseStoredSnapshot(existingRow.snapshot_json)
            : undefined;
        const runSignature = snapshotRunSignature(snapshot);
        const serializedEvents = this.#serializeEvents(snapshot.events);
        const canAppend = Boolean(
            !shouldReplace &&
            existing &&
            existing.snapshot.completed === snapshot.completed &&
            existing.snapshot.throughSequence <= snapshot.throughSequence &&
            hasSameRunSignature(existing.runSignature, runSignature) &&
            existing.eventFingerprints.length <= serializedEvents.length &&
            existing.eventFingerprints.every((event, index) => {
                const candidate = serializedEvents[index];
                return (
                    candidate?.runtimeSequence === event.runtimeSequence &&
                    candidate.fingerprint === event.fingerprint
                );
            })
        );
        if (!canAppend) {
            this.#deleteEventRows(sessionKey);
        }
        this.#insertEventRows(
            sessionKey,
            serializedEvents.slice(canAppend ? existing!.eventFingerprints.length : 0)
        );
        database
            .prepare(
                `DELETE FROM chat_runtime_snapshots
                 WHERE gateway_scope = ? AND session_key = ?`
            )
            .run(this.#gatewayScope, sessionKey);
        this.#insertSnapshotMetadata(
            sessionKey,
            snapshot,
            runSignature,
            serializedEvents,
            updatedAt
        );
    }

    #pruneSnapshots(): void {
        const pruneResult = database
            .prepare(PRUNE_SNAPSHOTS_SQL)
            .run(this.#gatewayScope, this.#gatewayScope, MAX_CHAT_RUNTIME_SESSIONS);
        if (pruneResult.changes > 0) {
            database.prepare(PRUNE_SNAPSHOT_EVENTS_SQL).run(this.#gatewayScope);
        }
    }

    clear(): void {
        const clearScope = database.transaction(() => {
            database
                .prepare(
                    "DELETE FROM chat_runtime_snapshot_events WHERE gateway_scope = ?"
                )
                .run(this.#gatewayScope);
            database
                .prepare("DELETE FROM chat_runtime_snapshots WHERE gateway_scope = ?")
                .run(this.#gatewayScope);
        });
        clearScope.immediate();
    }

    delete(sessionKey: string): void {
        const normalizedKey = normalizedSessionKey(sessionKey);
        const deleteSnapshot = database.transaction(() => {
            this.#deleteEventRows(normalizedKey);
            database
                .prepare(
                    "DELETE FROM chat_runtime_snapshots WHERE gateway_scope = ? AND session_key = ?"
                )
                .run(this.#gatewayScope, normalizedKey);
        });
        deleteSnapshot.immediate();
    }

    keys(): string[] {
        return (
            database
                .prepare(
                    "SELECT session_key FROM chat_runtime_snapshots WHERE gateway_scope = ?"
                )
                .all(this.#gatewayScope) as SnapshotKeyRow[]
        ).map((row) => normalizedSessionKey(row.session_key));
    }

    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined {
        const normalizedKey = normalizedSessionKey(sessionKey);
        const row = database
            .prepare(
                `SELECT snapshot_json
                 FROM chat_runtime_snapshots
                 WHERE gateway_scope = ? AND session_key = ?`
            )
            .get(this.#gatewayScope, normalizedKey) as SnapshotRow | undefined;
        const stored = row ? parseStoredSnapshot(row.snapshot_json) : undefined;
        if (!stored) {
            if (row) {
                this.delete(normalizedKey);
            }
            return undefined;
        }
        const eventRows = database
            .prepare(
                `SELECT runtime_sequence, envelope_json
                 FROM chat_runtime_snapshot_events
                 WHERE gateway_scope = ? AND session_key = ?
                 ORDER BY runtime_sequence ASC`
            )
            .all(this.#gatewayScope, normalizedKey) as SnapshotEventRow[];
        const events = eventRows.map((eventRow) =>
            parseStoredEvent(eventRow, stored.snapshot.throughSequence)
        );
        const hasMatchingFingerprints =
            eventRows.length === stored.eventFingerprints.length &&
            eventRows.every((eventRow, index) => {
                const storedFingerprint = stored.eventFingerprints[index];
                return (
                    storedFingerprint?.runtimeSequence === eventRow.runtime_sequence &&
                    storedFingerprint.fingerprint ===
                        eventFingerprint(eventRow.envelope_json)
                );
            });
        if (!hasMatchingFingerprints || events.includes(undefined)) {
            this.delete(normalizedKey);
            return undefined;
        }
        for (const [index, envelope] of events.entries()) {
            this.#eventFingerprints.set(
                envelope!,
                stored.eventFingerprints[index]!.fingerprint
            );
        }
        return {
            ...(stored.snapshot.acknowledgedRequestIds && {
                acknowledgedRequestIds: [...stored.snapshot.acknowledgedRequestIds],
            }),
            completed: stored.snapshot.completed,
            events: events as OpenClawRuntimeEnvelope[],
            ...(stored.snapshot.firstSequenceByRun && {
                firstSequenceByRun: {
                    ...stored.snapshot.firstSequenceByRun,
                },
            }),
            ...(stored.snapshot.interruptedAtByRun && {
                interruptedAtByRun: {
                    ...stored.snapshot.interruptedAtByRun,
                },
            }),
            ...(stored.snapshot.pendingRequestBoundaries && {
                pendingRequestBoundaries: {
                    ...stored.snapshot.pendingRequestBoundaries,
                },
            }),
            ...(stored.snapshot.requestBoundary !== undefined && {
                requestBoundary: stored.snapshot.requestBoundary,
            }),
            throughSequence: stored.snapshot.throughSequence,
        };
    }

    maximumSequence(): number {
        const row = database
            .prepare(
                `SELECT MAX(
                    CASE
                        WHEN json_valid(snapshot_json)
                        THEN CASE
                            WHEN json_type(snapshot_json, '$.throughSequence') = 'integer'
                                AND json_extract(snapshot_json, '$.throughSequence') >= 0
                                AND json_extract(snapshot_json, '$.throughSequence') <= ?
                            THEN json_extract(snapshot_json, '$.throughSequence')
                        END
                    END
                ) AS maximum_sequence
                FROM chat_runtime_snapshots
                WHERE gateway_scope = ?`
            )
            .get(Number.MAX_SAFE_INTEGER, this.#gatewayScope) as
            SnapshotMaximumSequenceRow | undefined;
        return typeof row?.maximum_sequence === "number" &&
            Number.isSafeInteger(row.maximum_sequence) &&
            row.maximum_sequence >= 0
            ? row.maximum_sequence
            : 0;
    }

    promote(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        sourceSnapshot: OpenClawRuntimeSnapshot,
        canonicalSnapshot: OpenClawRuntimeSnapshot
    ): void {
        const sourceKey = normalizedSessionKey(sourceSessionKey);
        const canonicalKey = normalizedSessionKey(canonicalSessionKey);
        const persist = database.transaction(() => {
            database
                .prepare(
                    `DELETE FROM chat_runtime_snapshot_events
                     WHERE gateway_scope = ? AND session_key IN (?, ?)`
                )
                .run(this.#gatewayScope, sourceKey, canonicalKey);
            database
                .prepare(
                    `DELETE FROM chat_runtime_snapshots
                     WHERE gateway_scope = ? AND session_key IN (?, ?)`
                )
                .run(this.#gatewayScope, sourceKey, canonicalKey);
            const updatedAt = this.#now();
            if (hasReplay(sourceSnapshot)) {
                this.#persistSnapshot(sourceKey, sourceSnapshot, updatedAt, true);
            }
            if (hasReplay(canonicalSnapshot)) {
                this.#persistSnapshot(canonicalKey, canonicalSnapshot, updatedAt, true);
            }
            this.#pruneSnapshots();
        });
        persist.immediate();
    }

    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void {
        const normalizedKey = normalizedSessionKey(sessionKey);
        const persist = database.transaction(() => {
            // Reinsert so a refresh always receives a newer rowid tie-breaker,
            // even when multiple writes share the same millisecond timestamp.
            this.#persistSnapshot(normalizedKey, snapshot, this.#now());
            this.#pruneSnapshots();
        });
        persist.immediate();
    }
}
