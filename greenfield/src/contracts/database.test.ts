import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { databaseObservabilityMetricDatabases } from "../shared/databaseObservabilityPolicy.ts";
import {
    databaseObservabilityCachePayloadMaximumBytes,
    databaseObservabilityCachePayloadSchema,
    databaseOverviewSchema,
    sqliteMigrationStateSchema,
} from "./database.ts";

const externalPayload = {
    databases: databaseObservabilityMetricDatabases.map((name) => ({
        cacheHitRatio: 99.5,
        committedTransactions: name === "bitmagnet" ? 120 : 0,
        connections: name === "bitmagnet" ? 3 : 0,
        name,
        rolledBackTransactions: name === "bitmagnet" ? 1 : 0,
        sizeBytes: name === "bitmagnet" ? 4096 : 0,
    })),
    pgbouncer: {
        averageQueryMs: 4.5,
        averageTransactionMs: 6,
        clientConnections: 3,
        maxWaitSeconds: 0,
        serverConnections: 2,
        waitingClients: 0,
    },
    statements: [
        {
            calls: 10,
            meanExecutionMs: 25,
            rank: 1,
            rows: 100,
            sharedBlocksHit: 90,
            sharedBlocksRead: 10,
            totalExecutionMs: 250,
        },
    ],
    summary: {
        activeConnections: 1,
        averageCacheHitRatio: 99.5,
        idleConnections: 2,
        maintenance: {
            assessedPhysicalBytes: 4096,
            assessmentComplete: true,
            estimatedReclaimableBytes: 0,
            estimatedReclaimablePercent: 0,
            highDeadTupleTableCount: 0,
            requiresBloatReview: false,
            slowStatementCount: 0,
            status: "healthy",
            unassessedPhysicalBytes: 0,
            unassessedTableCount: 0,
        },
        pgStatStatementsEnabled: true,
        totalConnections: 3,
        totalDatabaseSizeBytes: 4096,
    },
    tableHealth: [
        {
            assessment: "assessed",
            database: "bitmagnet",
            deadTuplePercent: 0,
            deadTuples: 0,
            estimatedReclaimableBytes: 0,
            lastAutoanalyzeAtMs: 900,
            lastAutovacuumAtMs: 800,
            liveTuples: 100,
            physicalBytes: 4096,
            schema: "public",
            table: "torrents",
        },
    ],
    torrentCounts: {
        bitmagnet: { count: 125_000, state: "available" },
        comet: { state: "unavailable" },
    },
} as const;

const overview = {
    checkedAtMs: 2000,
    postgresql: {
        ...externalPayload,
        observedAtMs: 1000,
        state: "fresh",
    },
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
        observedAtMs: 1000,
        state: "fresh",
        storage: {
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
            requiresVacuumReview: false,
            shmBytes: 32_768,
            storageBytes: 45_056,
            walBytes: 4096,
        },
    },
} as const;

describe("database overview contract", () => {
    test("accepts independent bounded SQLite and PostgreSQL observations", () => {
        expect(v.parse(databaseOverviewSchema, overview)).toEqual(overview);
        expect(v.parse(databaseObservabilityCachePayloadSchema, externalPayload)).toEqual(
            externalPayload
        );
    });

    test("cross-links restore verification to one exact retained inventory row", () => {
        const verifiedLifecycle = {
            backupInventory: {
                backups: [
                    {
                        bytes: 4096,
                        createdAtMs: 800,
                        kind: "scheduled",
                        restoreVerifiedAtMs: 850,
                        verificationLevel: "restore-copy-verified",
                    },
                ],
                observedAtMs: 900,
                state: "available",
                totalBytes: 4096,
            },
            maintenance: overview.sqlite.lifecycle.maintenance,
            restoreVerification: {
                backupBytes: 4096,
                backupCreatedAtMs: 800,
                observedAtMs: 900,
                state: "verified",
                verifiedAtMs: 850,
            },
        } as const;
        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                sqlite: { ...overview.sqlite, lifecycle: verifiedLifecycle },
            }).success
        ).toBe(true);

        for (const restoreVerification of [
            { ...verifiedLifecycle.restoreVerification, backupBytes: 4097 },
            { ...verifiedLifecycle.restoreVerification, backupCreatedAtMs: 801 },
            { ...verifiedLifecycle.restoreVerification, verifiedAtMs: 851 },
        ]) {
            expect(
                v.safeParse(databaseOverviewSchema, {
                    ...overview,
                    sqlite: {
                        ...overview.sqlite,
                        lifecycle: { ...verifiedLifecycle, restoreVerification },
                    },
                }).success
            ).toBe(false);
        }
    });

    test("keeps Comet and Bitmagnet count availability independent", () => {
        const reversedAvailability = {
            ...externalPayload,
            torrentCounts: {
                bitmagnet: { state: "unavailable" },
                comet: { count: 42, state: "available" },
            },
        } as const;
        expect(
            v.parse(databaseObservabilityCachePayloadSchema, reversedAvailability)
                .torrentCounts
        ).toEqual(reversedAvailability.torrentCounts);

        for (const torrentCounts of [
            {
                bitmagnet: { count: -1, state: "available" },
                comet: { state: "unavailable" },
            },
            {
                bitmagnet: { count: 1, state: "unavailable" },
                comet: { state: "unavailable" },
            },
            {
                bitmagnet: { state: "available" },
                comet: { state: "unavailable" },
            },
            {
                bitmagnet: { count: 1, state: "available" },
            },
        ]) {
            expect(
                v.safeParse(databaseObservabilityCachePayloadSchema, {
                    ...externalPayload,
                    torrentCounts,
                }).success
            ).toBe(false);
        }
    });

    test("rejects noncanonical, oversized, identity-bearing external data", () => {
        for (const payload of [
            {
                ...externalPayload,
                databases: externalPayload.databases.slice(1),
            },
            {
                ...externalPayload,
                databases: [
                    { ...externalPayload.databases[0], name: "zeta" },
                    { ...externalPayload.databases[0], name: "alpha" },
                ],
            },
            {
                ...externalPayload,
                statements: [{ ...externalPayload.statements[0], rank: 2 }],
            },
            {
                ...externalPayload,
                tableHealth: [
                    {
                        ...externalPayload.tableHealth[0],
                        database: "unreviewed",
                    },
                ],
            },
            {
                ...externalPayload,
                databases: [{ ...externalPayload.databases[0], user: "monitoring-user" }],
            },
            {
                ...externalPayload,
                statements: [
                    { ...externalPayload.statements[0], query: "SELECT secret" },
                ],
            },
            {
                ...externalPayload,
                tableHealth: Array.from({ length: 26 }, (_, index) => ({
                    ...externalPayload.tableHealth[0],
                    table: `table-${String(index).padStart(2, "0")}`,
                })),
            },
        ]) {
            expect(
                v.safeParse(databaseObservabilityCachePayloadSchema, payload).success
            ).toBe(false);
        }

        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...externalPayload,
                databases: [
                    {
                        ...externalPayload.databases[0],
                        name: "x".repeat(
                            databaseObservabilityCachePayloadMaximumBytes + 1
                        ),
                    },
                ],
            }).success
        ).toBe(false);

        const smallHighPercent = {
            ...externalPayload.tableHealth[0],
            deadTuplePercent: 30,
            deadTuples: 30,
            estimatedReclaimableBytes: 1024,
            physicalBytes: 4096,
            table: "small-high-percent",
        };
        const largeHighDead = {
            ...externalPayload.tableHealth[0],
            deadTuplePercent: 25,
            deadTuples: 2000,
            estimatedReclaimableBytes: 1024,
            physicalBytes: 64 * 1024 * 1024,
            table: "large-high-dead",
        };
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...externalPayload,
                summary: {
                    ...externalPayload.summary,
                    maintenance: {
                        ...externalPayload.summary.maintenance,
                        assessedPhysicalBytes:
                            smallHighPercent.physicalBytes + largeHighDead.physicalBytes,
                        estimatedReclaimableBytes: 2048,
                        estimatedReclaimablePercent:
                            (2048 /
                                (smallHighPercent.physicalBytes +
                                    largeHighDead.physicalBytes)) *
                            100,
                        highDeadTupleTableCount: 1,
                        status: "review",
                    },
                },
                tableHealth: [smallHighPercent, largeHighDead],
            }).success
        ).toBe(false);
    });

    test("rejects impossible maintenance and nested observation timestamps", () => {
        for (const maintenance of [
            { ...externalPayload.summary.maintenance, assessmentComplete: false },
            { ...externalPayload.summary.maintenance, estimatedReclaimableBytes: 1 },
            { ...externalPayload.summary.maintenance, estimatedReclaimablePercent: 1 },
            { ...externalPayload.summary.maintenance, requiresBloatReview: true },
            { ...externalPayload.summary.maintenance, slowStatementCount: 1 },
        ]) {
            expect(
                v.safeParse(databaseObservabilityCachePayloadSchema, {
                    ...externalPayload,
                    summary: { ...externalPayload.summary, maintenance },
                }).success
            ).toBe(false);
        }

        for (const payload of [
            {
                ...externalPayload,
                summary: { ...externalPayload.summary, totalDatabaseSizeBytes: 4095 },
            },
            {
                ...externalPayload,
                summary: { ...externalPayload.summary, averageCacheHitRatio: 99.4 },
            },
            {
                ...externalPayload,
                summary: {
                    ...externalPayload.summary,
                    activeConnections: 2,
                    idleConnections: 2,
                    totalConnections: 3,
                },
            },
            {
                ...externalPayload,
                tableHealth: [
                    {
                        ...externalPayload.tableHealth[0],
                        estimatedReclaimableBytes: 4097,
                    },
                ],
            },
            {
                ...externalPayload,
                statements: [
                    { ...externalPayload.statements[0], rank: 1, totalExecutionMs: 1 },
                    { ...externalPayload.statements[0], rank: 2, totalExecutionMs: 2 },
                ],
                summary: {
                    ...externalPayload.summary,
                    maintenance: {
                        ...externalPayload.summary.maintenance,
                        slowStatementCount: 0,
                    },
                },
            },
        ]) {
            expect(
                v.safeParse(databaseObservabilityCachePayloadSchema, payload).success
            ).toBe(false);
        }

        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                postgresql: {
                    ...overview.postgresql,
                    tableHealth: [
                        {
                            ...overview.postgresql.tableHealth[0],
                            lastAutovacuumAtMs: 1001,
                        },
                    ],
                },
            }).success
        ).toBe(false);
        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                postgresql: {
                    ...overview.postgresql,
                    statements: [{ ...overview.postgresql.statements[0], rank: 2 }],
                },
            }).success
        ).toBe(false);
    });

    test("rejects paths, identities, raw errors, and inconsistent timestamps", () => {
        for (const extra of [
            { databaseFileName: "mira-dashboard.db" },
            { path: "/private/state/mira-dashboard.db" },
            { rawError: "SQLITE_BUSY at /private/state/mira-dashboard.db" },
            { releaseId: "a".repeat(40) },
        ]) {
            expect(
                v.safeParse(databaseOverviewSchema, {
                    ...overview,
                    sqlite: { ...overview.sqlite, ...extra },
                }).success
            ).toBe(false);
        }
        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                checkedAtMs: 999,
            }).success
        ).toBe(false);
        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                sqlite: { ...overview.sqlite, fileName: "private.db" },
            }).success
        ).toBe(false);
    });

    test("requires internally consistent SQLite storage and explicit lifecycle gaps", () => {
        for (const storage of [
            { ...overview.sqlite.storage, freeBytes: 4095 },
            { ...overview.sqlite.storage, freePercent: 49 },
            { ...overview.sqlite.storage, storageBytes: 45_055 },
            {
                ...overview.sqlite.storage,
                permissions: {
                    ...overview.sqlite.storage.permissions,
                    database: "0644",
                },
            },
            { ...overview.sqlite.storage, requiresVacuumReview: true },
        ]) {
            expect(
                v.safeParse(databaseOverviewSchema, {
                    ...overview,
                    sqlite: { ...overview.sqlite, storage },
                }).success
            ).toBe(false);
        }

        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                sqlite: {
                    ...overview.sqlite,
                    lifecycle: {
                        ...overview.sqlite.lifecycle,
                        backupInventory: {
                            reason: "available",
                            state: "unavailable",
                        },
                    },
                },
            }).success
        ).toBe(false);

        const vacuumReviewStorage = {
            ...overview.sqlite.storage,
            freeBytes: 1024 * 1024 * 1024,
            freePages: 262_144,
            freePercent: 100,
            pageCount: 262_144,
            requiresVacuumReview: true,
        } as const;
        expect(
            v.safeParse(databaseOverviewSchema, {
                ...overview,
                sqlite: { ...overview.sqlite, storage: vacuumReviewStorage },
            }).success
        ).toBe(true);
    });

    test("requires migration current status to match the bounded counts", () => {
        expect(
            v.safeParse(sqliteMigrationStateSchema, {
                applied: 1,
                available: 2,
                current: true,
            }).success
        ).toBe(false);
        expect(
            v.safeParse(sqliteMigrationStateSchema, {
                applied: 65,
                available: 65,
                current: true,
            }).success
        ).toBe(false);
    });
});
