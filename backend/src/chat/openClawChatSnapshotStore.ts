import { database } from "../database.ts";
import {
    MAX_CHAT_RUNTIME_SESSIONS,
    type OpenClawChatSnapshotStore,
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "./openClawChatBridge.ts";

interface SnapshotRow {
    snapshot_json: string;
}

interface SnapshotKeyRow {
    session_key: string;
}

interface SnapshotMaximumSequenceRow {
    maximum_sequence: unknown;
}

const SAVE_SNAPSHOT_SQL = `
    INSERT INTO chat_runtime_snapshots (
        gateway_scope,
        session_key,
        snapshot_json,
        updated_at
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

function parseSnapshot(serialized: string): OpenClawRuntimeSnapshot | undefined {
    try {
        const value = JSON.parse(serialized) as Record<string, unknown>;
        const events = Array.isArray(value.events) ? value.events : [];
        const throughSequence = value.throughSequence;
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.completed !== "boolean" ||
            !Array.isArray(value.events) ||
            !events.every(isRuntimeEnvelope) ||
            !Number.isSafeInteger(throughSequence) ||
            (throughSequence as number) < 0 ||
            events.some(
                (event) =>
                    (event as OpenClawRuntimeEnvelope).runtimeSequence >
                    (throughSequence as number)
            )
        ) {
            return undefined;
        }
        return value as unknown as OpenClawRuntimeSnapshot;
    } catch {
        return undefined;
    }
}

/** Persists the bounded bridge replay without exposing its payload as a new API. */
export class SqliteOpenClawChatSnapshotStore implements OpenClawChatSnapshotStore {
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

    clear(): void {
        database
            .prepare("DELETE FROM chat_runtime_snapshots WHERE gateway_scope = ?")
            .run(this.#gatewayScope);
    }

    delete(sessionKey: string): void {
        database
            .prepare(
                "DELETE FROM chat_runtime_snapshots WHERE gateway_scope = ? AND session_key = ?"
            )
            .run(this.#gatewayScope, sessionKey);
    }

    keys(): string[] {
        return (
            database
                .prepare(
                    "SELECT session_key FROM chat_runtime_snapshots WHERE gateway_scope = ?"
                )
                .all(this.#gatewayScope) as SnapshotKeyRow[]
        ).map((row) => row.session_key);
    }

    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined {
        const row = database
            .prepare(
                `SELECT snapshot_json
                 FROM chat_runtime_snapshots
                 WHERE gateway_scope = ? AND session_key = ?`
            )
            .get(this.#gatewayScope, sessionKey) as SnapshotRow | undefined;
        const snapshot = row ? parseSnapshot(row.snapshot_json) : undefined;
        if (row && !snapshot) {
            this.delete(sessionKey);
        }
        return snapshot;
    }

    maximumSequence(): number {
        const row = database
            .prepare(
                `SELECT MAX(
                    CASE
                        WHEN json_valid(snapshot_json)
                        THEN CASE
                            WHEN json_type(snapshot_json, '$.throughSequence') = 'integer'
                            THEN json_extract(snapshot_json, '$.throughSequence')
                        END
                    END
                ) AS maximum_sequence
                FROM chat_runtime_snapshots
                WHERE gateway_scope = ?`
            )
            .get(this.#gatewayScope) as SnapshotMaximumSequenceRow | undefined;
        return typeof row?.maximum_sequence === "number" &&
            Number.isSafeInteger(row.maximum_sequence) &&
            row.maximum_sequence >= 0
            ? row.maximum_sequence
            : 0;
    }

    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void {
        const persist = database.transaction(() => {
            // Reinsert so a refresh always receives a newer rowid tie-breaker,
            // even when multiple writes share the same millisecond timestamp.
            this.delete(sessionKey);
            database
                .prepare(SAVE_SNAPSHOT_SQL)
                .run(
                    this.#gatewayScope,
                    sessionKey,
                    JSON.stringify(snapshot),
                    this.#now()
                );
            database
                .prepare(PRUNE_SNAPSHOTS_SQL)
                .run(this.#gatewayScope, this.#gatewayScope, MAX_CHAT_RUNTIME_SESSIONS);
        });
        persist();
    }
}
