import * as v from "valibot";

import {
    type DatabaseOverview,
    databaseObservabilityCacheKey,
    databaseObservabilityCachePayloadSchema,
    databaseObservabilityCacheSchemaId,
    databaseObservabilityCacheSource,
    databaseObservabilityExternalLastKnownGoodMs,
    databaseOverviewSchema,
    type SqliteLifecycleObservation,
    sqliteReusableSpaceRequiresVacuumReview,
} from "../../../contracts/database.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { DatabaseRuntimeObservation } from "../../database/runtime/databaseService.ts";
import type { SqliteLifecycleReader } from "./sqliteLifecycle.ts";

/** Maximum age of a retained successful SQLite observation after a read failure. */
export const databaseObservabilityLastKnownGoodMs = 24 * 60 * 60_000;

export interface DatabaseObservabilityService {
    read(): Promise<DatabaseOverview>;
}

export interface DatabaseObservabilityServiceOptions {
    readonly lastKnownGoodMs?: number;
    readonly lifecycleReader?: SqliteLifecycleReader;
    readonly nowMs?: () => number;
    readonly readDiagnostics: () => Promise<DatabaseRuntimeObservation>;
    readonly snapshotRepository?: DatabaseObservabilitySnapshotRepository;
}

/** Exact domain-only cache row admitted by the database observability service. */
export interface DatabaseObservabilitySnapshotRecord {
    readonly expiresAtMs: number | null;
    readonly key: string;
    readonly lastAttemptAtMs: number;
    readonly lastAttemptStatus: "failed" | "succeeded";
    readonly lastSuccessAtMs: number | null;
    readonly payload: unknown;
    readonly schemaId: string | null;
    readonly source: string | null;
}

/** Narrow read-only repository port; it cannot enumerate or expose generic cache entries. */
export interface DatabaseObservabilitySnapshotRepository {
    read(): DatabaseObservabilitySnapshotRecord | undefined;
}

type AvailableSqliteObservation = Extract<
    DatabaseOverview["sqlite"],
    { readonly state: "fresh" | "last-known-good" }
>;

function checkedTime(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("Database observability clock is invalid");
    }
    return value;
}

function projectDiagnostics(
    diagnostics: DatabaseRuntimeObservation,
    observedAtMs: number,
    lifecycle: SqliteLifecycleObservation
): AvailableSqliteObservation {
    if (
        diagnostics.connection.busyTimeoutMs !== 0 ||
        diagnostics.connection.synchronousLevel !== 2
    ) {
        throw new RangeError("Database runtime connection policy is unsupported");
    }
    return {
        connection: {
            busyPolicy: "non-blocking",
            checksEnforced: diagnostics.connection.checksEnforced,
            foreignKeysEnabled: diagnostics.connection.foreignKeysEnabled,
            journalMode: diagnostics.connection.journalMode,
            synchronousMode: "full",
            trustedSchemaEnabled: diagnostics.connection.trustedSchemaEnabled,
            walAutoCheckpointPages: diagnostics.connection.walAutoCheckpointPages,
        },
        fileName: diagnostics.databaseFileName,
        lifecycle,
        migrations: {
            // A retained runtime is admitted only after the complete bundled
            // migration graph has been verified. `appliedMigrations` records
            // work performed during this process startup, so it is zero for an
            // already-current database and must not be projected as progress.
            applied: diagnostics.migrationCount,
            available: diagnostics.migrationCount,
            current: true,
        },
        observedAtMs,
        state: "fresh",
        storage: {
            ...diagnostics.sqlite,
            requiresVacuumReview: sqliteReusableSpaceRequiresVacuumReview(
                diagnostics.sqlite.freeBytes,
                diagnostics.sqlite.freePercent
            ),
        },
    };
}

function projectExternalSnapshot(
    record: DatabaseObservabilitySnapshotRecord | undefined,
    checkedAtMs: number
): DatabaseOverview["postgresql"] {
    if (
        record === undefined ||
        record.key !== databaseObservabilityCacheKey ||
        record.schemaId !== databaseObservabilityCacheSchemaId ||
        record.source !== databaseObservabilityCacheSource ||
        record.expiresAtMs === null ||
        record.lastSuccessAtMs === null ||
        (record.lastAttemptStatus !== "failed" &&
            record.lastAttemptStatus !== "succeeded")
    ) {
        return { state: "unavailable" };
    }
    if (
        [record.lastAttemptAtMs, record.lastSuccessAtMs].some(
            (value) => !Number.isSafeInteger(value) || value < 0 || value > checkedAtMs
        ) ||
        !Number.isSafeInteger(record.expiresAtMs) ||
        record.expiresAtMs < 0 ||
        record.expiresAtMs <= record.lastSuccessAtMs ||
        record.lastSuccessAtMs > record.lastAttemptAtMs ||
        (record.lastAttemptStatus === "succeeded" &&
            record.lastAttemptAtMs !== record.lastSuccessAtMs)
    ) {
        return { state: "unavailable" };
    }
    const payload =
        typeof record.payload === "string"
            ? parseJsonText(record.payload)
            : record.payload;
    const parsed = v.safeParse(databaseObservabilityCachePayloadSchema, payload);
    if (!parsed.success) return { state: "unavailable" };
    if (
        parsed.output.tableHealth.some(
            (row) =>
                (row.lastAutovacuumAtMs !== undefined &&
                    row.lastAutovacuumAtMs > record.lastSuccessAtMs!) ||
                (row.lastAutoanalyzeAtMs !== undefined &&
                    row.lastAutoanalyzeAtMs > record.lastSuccessAtMs!)
        )
    ) {
        return { state: "unavailable" };
    }

    const ageMs = checkedAtMs - record.lastSuccessAtMs;
    if (ageMs > databaseObservabilityExternalLastKnownGoodMs) {
        return { state: "unavailable" };
    }
    const fresh =
        record.lastAttemptStatus === "succeeded" &&
        record.lastAttemptAtMs === record.lastSuccessAtMs &&
        record.expiresAtMs > checkedAtMs;
    if (fresh) {
        return {
            ...parsed.output,
            observedAtMs: record.lastSuccessAtMs,
            state: "fresh",
        };
    }
    let staleSinceMs = record.expiresAtMs;
    if (record.lastAttemptStatus === "failed") {
        staleSinceMs = record.lastAttemptAtMs;
    }
    return {
        ...parsed.output,
        observedAtMs: record.lastSuccessAtMs,
        staleSinceMs,
        state: "last-known-good",
    };
}

/**
 * Creates one single-flight database reader with independent SQLite and external states.
 * Runtime paths, release identity, startup mode, and raw failures are deliberately discarded.
 * @param options - Runtime diagnostics reader, clock, and bounded fallback policy.
 * @returns One immutable request-safe database observability service.
 */
export function createDatabaseObservabilityService(
    options: DatabaseObservabilityServiceOptions
): DatabaseObservabilityService {
    const nowMs = options.nowMs ?? Date.now;
    const lastKnownGoodMs =
        options.lastKnownGoodMs ?? databaseObservabilityLastKnownGoodMs;
    if (!Number.isSafeInteger(lastKnownGoodMs) || lastKnownGoodMs < 0) {
        throw new RangeError("Database observability stale window is invalid");
    }

    let inFlight: Promise<DatabaseOverview> | undefined;
    let lastKnownGood: AvailableSqliteObservation | undefined;
    let staleSinceMs: number | undefined;

    const load = async (): Promise<DatabaseOverview> => {
        let checkedAtMs = 0;
        try {
            checkedAtMs = checkedTime(nowMs);
        } catch {
            // An invalid clock is handled by the bounded unavailable fallback.
        }
        let postgresqlRecord: DatabaseObservabilitySnapshotRecord | undefined;
        try {
            postgresqlRecord = options.snapshotRepository?.read();
        } catch {
            // External cache corruption or read failure cannot suppress SQLite.
        }
        try {
            let lifecycle: SqliteLifecycleObservation = {
                backupInventory: {
                    reason: "inventory-unavailable",
                    state: "unavailable",
                },
                maintenance: {
                    reason: "maintenance-unavailable",
                    state: "unavailable",
                },
                restoreVerification: {
                    reason: "verification-unavailable",
                    state: "unavailable",
                },
            };
            if (options.lifecycleReader !== undefined) {
                try {
                    lifecycle = await options.lifecycleReader.read();
                } catch {
                    // Lifecycle sources are independent from live SQLite diagnostics.
                }
            }
            const diagnostics = await options.readDiagnostics();
            // Collection boundaries may timestamp observations while awaiting I/O.
            // Capture the response clock afterwards so every nested timestamp is causal.
            checkedAtMs = checkedTime(nowMs);
            let postgresql: DatabaseOverview["postgresql"] = { state: "unavailable" };
            try {
                postgresql = projectExternalSnapshot(postgresqlRecord, checkedAtMs);
            } catch {
                // External cache corruption cannot suppress SQLite.
            }
            const sqlite = projectDiagnostics(diagnostics, checkedAtMs, lifecycle);
            const result = v.parse(databaseOverviewSchema, {
                checkedAtMs,
                postgresql,
                sqlite,
            });
            lastKnownGood = result.sqlite as AvailableSqliteObservation;
            staleSinceMs = undefined;
            return result;
        } catch {
            try {
                checkedAtMs = checkedTime(nowMs);
            } catch {
                // Keep the bounded unavailable fallback timestamp.
            }
            let postgresql: DatabaseOverview["postgresql"] = { state: "unavailable" };
            try {
                postgresql = projectExternalSnapshot(postgresqlRecord, checkedAtMs);
            } catch {
                // External cache corruption cannot suppress SQLite fallback state.
            }
            const ageMs =
                lastKnownGood === undefined
                    ? Number.POSITIVE_INFINITY
                    : checkedAtMs - lastKnownGood.observedAtMs;
            if (lastKnownGood !== undefined && ageMs >= 0 && ageMs <= lastKnownGoodMs) {
                // Wall-clock regression must not make a previously retained
                // stale timestamp non-causal for this response.
                if (staleSinceMs === undefined || staleSinceMs > checkedAtMs) {
                    staleSinceMs = checkedAtMs;
                }
                return v.parse(databaseOverviewSchema, {
                    checkedAtMs,
                    postgresql,
                    sqlite: {
                        connection: lastKnownGood.connection,
                        fileName: lastKnownGood.fileName,
                        lifecycle: lastKnownGood.lifecycle,
                        migrations: lastKnownGood.migrations,
                        observedAtMs: lastKnownGood.observedAtMs,
                        staleSinceMs,
                        state: "last-known-good",
                        storage: lastKnownGood.storage,
                    },
                });
            }
            return v.parse(databaseOverviewSchema, {
                checkedAtMs,
                postgresql,
                sqlite: { state: "unavailable" },
            });
        }
    };

    return Object.freeze({
        read() {
            if (inFlight !== undefined) return inFlight;
            const current = load();
            inFlight = current;
            const clear = () => {
                if (inFlight === current) inFlight = undefined;
            };
            void current.then(clear, clear);
            return current;
        },
    });
}
