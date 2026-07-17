import { database } from "../database.ts";
import type {
    OpenClawChatSnapshotStore,
    OpenClawRuntimeEnvelope,
    OpenClawRuntimeSnapshot,
} from "./openClawChatBridge.ts";

interface SnapshotRow {
    session_key: string;
    snapshot_json: string;
}

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
    clear(): void {
        database.prepare("DELETE FROM chat_runtime_snapshots").run();
    }

    delete(sessionKey: string): void {
        database
            .prepare("DELETE FROM chat_runtime_snapshots WHERE session_key = ?")
            .run(sessionKey);
    }

    keys(): string[] {
        return (
            database
                .prepare("SELECT session_key FROM chat_runtime_snapshots")
                .all() as Array<Pick<SnapshotRow, "session_key">>
        ).map((row) => row.session_key);
    }

    load(sessionKey: string): OpenClawRuntimeSnapshot | undefined {
        const row = database
            .prepare(
                "SELECT session_key, snapshot_json FROM chat_runtime_snapshots WHERE session_key = ?"
            )
            .get(sessionKey) as SnapshotRow | undefined;
        return row ? parseSnapshot(row.snapshot_json) : undefined;
    }

    save(sessionKey: string, snapshot: OpenClawRuntimeSnapshot): void {
        database
            .prepare(
                `INSERT INTO chat_runtime_snapshots (session_key, snapshot_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(session_key) DO UPDATE SET
                     snapshot_json = excluded.snapshot_json,
                     updated_at = excluded.updated_at`
            )
            .run(sessionKey, JSON.stringify(snapshot), new Date().toISOString());
    }
}

export const openClawChatSnapshotStore = new SqliteOpenClawChatSnapshotStore();
