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

const SAVE_SNAPSHOT_SQL = `
    INSERT INTO chat_runtime_snapshots (
        gateway_scope,
        session_key,
        snapshot_json,
        updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(gateway_scope, session_key) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at
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
        Number.isFinite(envelope.runtimeSequence)
    );
}

function parseSnapshot(serialized: string): OpenClawRuntimeSnapshot | undefined {
    try {
        const value = JSON.parse(serialized) as Record<string, unknown>;
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            typeof value.completed !== "boolean" ||
            !Array.isArray(value.events) ||
            !value.events.every(isRuntimeEnvelope) ||
            !Number.isFinite(value.throughSequence)
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

    constructor(gatewayScope: string) {
        const normalizedScope = gatewayScope.trim();
        if (!normalizedScope) {
            throw new Error("Gateway scope is required for chat runtime persistence");
        }
        this.#gatewayScope = normalizedScope;
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

    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void {
        const persist = database.transaction(() => {
            database
                .prepare(SAVE_SNAPSHOT_SQL)
                .run(
                    this.#gatewayScope,
                    sessionKey,
                    JSON.stringify(snapshot),
                    new Date().toISOString()
                );
            database
                .prepare(PRUNE_SNAPSHOTS_SQL)
                .run(this.#gatewayScope, this.#gatewayScope, MAX_CHAT_RUNTIME_SESSIONS);
        });
        persist();
    }
}
