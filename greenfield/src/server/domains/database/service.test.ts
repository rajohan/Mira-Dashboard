import { describe, expect, test } from "bun:test";

import type { DatabaseObservabilityCachePayload } from "../../../contracts/database.ts";
import { databaseObservabilityMetricDatabases } from "../../../shared/databaseObservabilityPolicy.ts";
import type { DatabaseRuntimeObservation } from "../../database/runtime/databaseService.ts";
import {
    createDatabaseObservabilityService,
    type DatabaseObservabilitySnapshotRecord,
} from "./service.ts";

const diagnostics = {
    appliedMigrations: 1,
    connection: {
        busyTimeoutMs: 0,
        checksEnforced: true,
        foreignKeysEnabled: true,
        journalMode: "wal",
        synchronousLevel: 2,
        trustedSchemaEnabled: false,
        walAutoCheckpointPages: 1000,
    },
    databaseFileName: "mira-dashboard.db",
    migrationCount: 1,
    sqlite: {
        databaseBytes: 8192,
        freeBytes: 4096,
        freePages: 1,
        freePercent: 50,
        pageCount: 2,
        pageSizeBytes: 4096,
        permissions: {
            dataDirectory: "0700",
            database: "0600",
            secure: true,
            shm: "0600",
            wal: "0600",
        },
        shmBytes: 32_768,
        storageBytes: 45_056,
        walBytes: 4096,
    },
    startupMode: "validate-only",
} as const satisfies DatabaseRuntimeObservation;

const externalPayload = {
    databases: databaseObservabilityMetricDatabases.map((name) => ({
        cacheHitRatio: 99,
        committedTransactions: name === "comet" ? 100 : 0,
        connections: name === "comet" ? 2 : 0,
        name,
        rolledBackTransactions: name === "comet" ? 1 : 0,
        sizeBytes: name === "comet" ? 4096 : 0,
    })),
    pgbouncer: {
        averageQueryMs: 5,
        averageTransactionMs: 8,
        clientConnections: 2,
        maxWaitSeconds: 0,
        serverConnections: 1,
        waitingClients: 0,
    },
    statements: [],
    summary: {
        activeConnections: 1,
        averageCacheHitRatio: 99,
        idleConnections: 1,
        maintenance: {
            assessedPhysicalBytes: 0,
            assessmentComplete: false,
            estimatedReclaimableBytes: 0,
            estimatedReclaimablePercent: 0,
            highDeadTupleTableCount: 0,
            requiresBloatReview: false,
            slowStatementCount: 0,
            status: "not-assessed",
            unassessedPhysicalBytes: 4096,
            unassessedTableCount: 1,
        },
        pgStatStatementsEnabled: false,
        totalConnections: 2,
        totalDatabaseSizeBytes: 4096,
    },
    tableHealth: [
        {
            assessment: "unavailable",
            database: "comet",
            deadTuplePercent: 2,
            deadTuples: 2,
            lastAutovacuumAtMs: 900,
            liveTuples: 100,
            physicalBytes: 4096,
            schema: "public",
            table: "torrents",
        },
    ],
    torrentCounts: {
        bitmagnet: { state: "unavailable" },
        comet: { state: "unavailable" },
    },
} as const satisfies DatabaseObservabilityCachePayload;

function snapshot(
    overrides: Partial<DatabaseObservabilitySnapshotRecord> = {}
): DatabaseObservabilitySnapshotRecord {
    return {
        expiresAtMs: 6400,
        key: "database.observability",
        lastAttemptAtMs: 1000,
        lastAttemptStatus: "succeeded",
        lastSuccessAtMs: 1000,
        payload: externalPayload,
        schemaId: "database.observability.v1",
        source: "postgresql.pgbouncer",
        ...overrides,
    };
}

describe("database observability service", () => {
    test("projects only canonical identity-free runtime diagnostics", async () => {
        const service = createDatabaseObservabilityService({
            nowMs: () => 2000,
            readDiagnostics: () => Promise.resolve(diagnostics),
        });

        const result = await service.read();
        expect(result).toEqual({
            checkedAtMs: 2000,
            postgresql: { state: "unavailable" },
            sqlite: {
                connection: {
                    busyPolicy: "non-blocking",
                    checksEnforced: true,
                    foreignKeysEnabled: true,
                    journalMode: "wal",
                    synchronousMode: "full",
                    trustedSchemaEnabled: false,
                    walAutoCheckpointPages: 1000,
                },
                fileName: "mira-dashboard.db",
                lifecycle: {
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
                },
                migrations: { applied: 1, available: 1, current: true },
                observedAtMs: 2000,
                state: "fresh",
                storage: {
                    ...diagnostics.sqlite,
                    requiresVacuumReview: false,
                },
            },
        });
        expect(result.sqlite).toMatchObject({ fileName: "mira-dashboard.db" });
        expect(JSON.stringify(result)).not.toContain("/state/");
        expect(JSON.stringify(result)).not.toContain("validate-only");
    });

    test("treats an already-validated runtime as fully migrated", async () => {
        const service = createDatabaseObservabilityService({
            nowMs: () => 2000,
            readDiagnostics: () =>
                Promise.resolve({
                    ...diagnostics,
                    appliedMigrations: 0,
                }),
        });

        const result = await service.read();
        expect(result.sqlite).toMatchObject({
            migrations: { applied: 1, available: 1, current: true },
            state: "fresh",
        });
    });

    test("returns unavailable without retaining raw failures before first success", async () => {
        const service = createDatabaseObservabilityService({
            nowMs: () => 2000,
            readDiagnostics: () =>
                Promise.reject(new Error("private /state/database path failed")),
        });

        const result = await service.read();
        expect(result).toEqual({
            checkedAtMs: 2000,
            postgresql: { state: "unavailable" },
            sqlite: { state: "unavailable" },
        });
        expect(JSON.stringify(result)).not.toContain("private");
    });

    test("fails closed instead of misreporting unexpected connection policy", async () => {
        for (const connection of [
            { ...diagnostics.connection, busyTimeoutMs: 5000 },
            { ...diagnostics.connection, synchronousLevel: 1 as 2 },
        ]) {
            const service = createDatabaseObservabilityService({
                nowMs: () => 2000,
                readDiagnostics: () => Promise.resolve({ ...diagnostics, connection }),
            });

            expect(await service.read()).toEqual({
                checkedAtMs: 2000,
                postgresql: { state: "unavailable" },
                sqlite: { state: "unavailable" },
            });
        }
    });

    test("uses one bounded last-known-good value and expires it", async () => {
        let nowMs = 1000;
        let readAttempts = 0;
        const service = createDatabaseObservabilityService({
            lastKnownGoodMs: 30_000,
            nowMs: () => nowMs,
            readDiagnostics: () => {
                readAttempts += 1;
                return readAttempts === 1
                    ? Promise.resolve(diagnostics)
                    : Promise.reject(new Error("private SQL failure"));
            },
        });

        await service.read();
        nowMs = 2000;
        const stale = await service.read();
        expect(stale.sqlite).toMatchObject({
            observedAtMs: 1000,
            staleSinceMs: 2000,
            state: "last-known-good",
        });
        nowMs = 31_001;
        expect(await service.read()).toEqual({
            checkedAtMs: 31_001,
            postgresql: { state: "unavailable" },
            sqlite: { state: "unavailable" },
        });
    });

    test("keeps retained timestamps causal across wall-clock regression", async () => {
        let nowMs = 1000;
        let readAttempts = 0;
        const service = createDatabaseObservabilityService({
            nowMs: () => nowMs,
            readDiagnostics: () => {
                readAttempts += 1;
                return readAttempts === 1
                    ? Promise.resolve(diagnostics)
                    : Promise.reject(new Error("private SQL failure"));
            },
        });

        await service.read();
        nowMs = 2000;
        const firstStale = await service.read();
        expect(firstStale.sqlite).toMatchObject({ staleSinceMs: 2000 });
        nowMs = 1500;
        const regressed = await service.read();
        expect(regressed.sqlite).toMatchObject({
            observedAtMs: 1000,
            staleSinceMs: 1500,
            state: "last-known-good",
        });
    });

    test("coalesces concurrent diagnostics reads", async () => {
        const pending = Promise.withResolvers<DatabaseRuntimeObservation>();
        let reads = 0;
        const service = createDatabaseObservabilityService({
            nowMs: () => 1000,
            readDiagnostics: () => {
                reads += 1;
                return pending.promise;
            },
        });

        const first = service.read();
        const second = service.read();
        expect(first).toBe(second);
        expect(reads).toBe(1);
        pending.resolve(diagnostics);
        expect(await first).toEqual(await second);
    });

    test("joins a fresh exact external snapshot independently from SQLite", async () => {
        const service = createDatabaseObservabilityService({
            nowMs: () => 2000,
            readDiagnostics: () => Promise.reject(new Error("SQLite unavailable")),
            snapshotRepository: { read: () => snapshot() },
        });

        expect(await service.read()).toEqual({
            checkedAtMs: 2000,
            postgresql: {
                ...externalPayload,
                observedAtMs: 1000,
                state: "fresh",
            },
            sqlite: { state: "unavailable" },
        });
    });

    test("marks failed or expired external refreshes last-known-good for at most 24 hours", async () => {
        let record = snapshot({
            expiresAtMs: 1500,
            lastAttemptAtMs: 1800,
            lastAttemptStatus: "failed",
        });
        let nowMs = 2000;
        const service = createDatabaseObservabilityService({
            nowMs: () => nowMs,
            readDiagnostics: () => Promise.resolve(diagnostics),
            snapshotRepository: { read: () => record },
        });

        const stale = await service.read();
        expect(stale.postgresql).toMatchObject({
            observedAtMs: 1000,
            staleSinceMs: 1800,
            state: "last-known-good",
        });
        nowMs = 1000 + 24 * 60 * 60 * 1000 + 1;
        record = snapshot({ expiresAtMs: 6400 });
        const expired = await service.read();
        expect(expired.postgresql).toEqual({ state: "unavailable" });
    });

    test("fails malformed or mismatched external cache data closed without hiding SQLite", async () => {
        for (const record of [
            snapshot({ key: "system.host" }),
            snapshot({ schemaId: "database.observability.v2" }),
            snapshot({ source: "private-host" }),
            snapshot({ payload: { ...externalPayload, password: "secret" } }),
            snapshot({
                payload: {
                    ...externalPayload,
                    databases: externalPayload.databases.slice(1),
                },
            }),
            snapshot({
                payload: {
                    ...externalPayload,
                    tableHealth: [
                        {
                            ...externalPayload.tableHealth[0],
                            database: "unreviewed",
                        },
                    ],
                },
            }),
            snapshot({
                payload: {
                    ...externalPayload,
                    tableHealth: [
                        { ...externalPayload.tableHealth[0], lastAutovacuumAtMs: 1001 },
                    ],
                },
            }),
        ]) {
            const service = createDatabaseObservabilityService({
                nowMs: () => 2000,
                readDiagnostics: () => Promise.resolve(diagnostics),
                snapshotRepository: { read: () => record },
            });
            const result = await service.read();
            expect(result.postgresql).toEqual({ state: "unavailable" });
            expect(result.sqlite.state).toBe("fresh");
            expect(JSON.stringify(result)).not.toContain("secret");
            expect(JSON.stringify(result)).not.toContain("private-host");
        }
    });

    test("contains cache repository failures within the external source", async () => {
        const service = createDatabaseObservabilityService({
            nowMs: () => 2000,
            readDiagnostics: () => Promise.resolve(diagnostics),
            snapshotRepository: {
                read: () => {
                    throw new Error("private cache failure");
                },
            },
        });

        expect(await service.read()).toMatchObject({
            postgresql: { state: "unavailable" },
            sqlite: { state: "fresh" },
        });
    });
});
