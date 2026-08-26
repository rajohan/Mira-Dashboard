import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    databaseObservabilityCachePayloadMaximumBytes,
    databaseObservabilityCachePayloadSchema,
    databaseObservabilityDatabaseMaximum,
    databaseOverviewSchema,
    sqliteMigrationStateSchema,
    sqliteReusableSpaceRequiresVacuumReview,
} from "./database.ts";

const observedDatabases = ["alpha", "bitmagnet", "comet"] as const;

const externalPayload = {
    databases: observedDatabases.map((name) => ({
        blocksHit: 199,
        blocksRead: 1,
        cacheHitRatio: 99.5,
        committedTransactions: name === "bitmagnet" ? 120 : 0,
        connections: name === "bitmagnet" ? 3 : 0,
        detailsState: "available" as const,
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
        unavailableDatabaseCount: 0,
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

    test("reviews only recurring materially slow statements", () => {
        const statement = externalPayload.statements[0];
        const occasionalSlowPayload = {
            ...externalPayload,
            statements: [
                {
                    ...statement,
                    calls: 24,
                    meanExecutionMs: 2000,
                    totalExecutionMs: 48_000,
                },
            ],
        };
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, occasionalSlowPayload)
                .success
        ).toBe(true);

        const recurringSlowPayload = {
            ...occasionalSlowPayload,
            statements: [
                {
                    ...occasionalSlowPayload.statements[0],
                    calls: 25,
                    meanExecutionMs: 1000,
                },
            ],
            summary: {
                ...occasionalSlowPayload.summary,
                maintenance: {
                    ...occasionalSlowPayload.summary.maintenance,
                    slowStatementCount: 1,
                    status: "review" as const,
                },
            },
        };
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, recurringSlowPayload)
                .success
        ).toBe(true);
    });

    test("keeps immaterial unassessed table space healthy and visible", () => {
        const immaterialUnassessedPayload = {
            ...externalPayload,
            summary: {
                ...externalPayload.summary,
                maintenance: {
                    ...externalPayload.summary.maintenance,
                    assessedPhysicalBytes: 0,
                    unassessedPhysicalBytes: 4096,
                    unassessedTableCount: 1,
                },
            },
            tableHealth: [
                {
                    assessment: "unavailable" as const,
                    database: "bitmagnet",
                    deadTuplePercent: 0,
                    deadTuples: 0,
                    lastAutoanalyzeAtMs: 900,
                    lastAutovacuumAtMs: 800,
                    liveTuples: 100,
                    physicalBytes: 4096,
                    schema: "public",
                    table: "torrents",
                },
            ],
        };
        expect(
            v.safeParse(
                databaseObservabilityCachePayloadSchema,
                immaterialUnassessedPayload
            ).success
        ).toBe(true);
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

    test("weights the global cache-hit ratio by observed block traffic", () => {
        const databases = externalPayload.databases.map((database, index) => {
            const [blocksHit, blocksRead] = (
                [
                    [0, 0],
                    [900, 100],
                    [1, 0],
                ] as const
            )[index]!;
            return {
                ...database,
                blocksHit,
                blocksRead,
                cacheHitRatio:
                    blocksHit + blocksRead === 0
                        ? 100
                        : (blocksHit / (blocksHit + blocksRead)) * 100,
            };
        });
        const weightedRatio = (901 / 1001) * 100;
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...externalPayload,
                databases,
                summary: {
                    ...externalPayload.summary,
                    averageCacheHitRatio: weightedRatio,
                },
            }).success
        ).toBe(true);
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...externalPayload,
                databases,
                summary: {
                    ...externalPayload.summary,
                    averageCacheHitRatio:
                        databases.reduce(
                            (total, database) => total + database.cacheHitRatio,
                            0
                        ) / databases.length,
                },
            }).success
        ).toBe(false);
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...externalPayload,
                databases: externalPayload.databases.map((database) => ({
                    ...database,
                    blocksHit: 0,
                    blocksRead: 0,
                    cacheHitRatio: 100,
                })),
                summary: {
                    ...externalPayload.summary,
                    averageCacheHitRatio: 100,
                },
            }).success
        ).toBe(true);
    });

    test("matches PostgreSQL's 63-byte identifier boundary", () => {
        const renameFirstDatabase = (name: string) => ({
            ...externalPayload,
            databases: externalPayload.databases
                .map((database, index) =>
                    index === 0 ? { ...database, name } : database
                )
                .toSorted((left, right) => {
                    if (left.name < right.name) return -1;
                    if (left.name > right.name) return 1;
                    return 0;
                }),
        });

        expect(
            v.safeParse(
                databaseObservabilityCachePayloadSchema,
                renameFirstDatabase("a".repeat(63))
            ).success
        ).toBe(true);
        expect(
            v.safeParse(
                databaseObservabilityCachePayloadSchema,
                renameFirstDatabase("€".repeat(21))
            ).success
        ).toBe(true);
        expect(
            v.safeParse(
                databaseObservabilityCachePayloadSchema,
                renameFirstDatabase("a".repeat(64))
            ).success
        ).toBe(false);
        expect(
            v.safeParse(
                databaseObservabilityCachePayloadSchema,
                renameFirstDatabase("€".repeat(22))
            ).success
        ).toBe(false);
    });

    test("rejects noncanonical, oversized, identity-bearing external data", () => {
        for (const payload of [
            {
                ...externalPayload,
                databases: [],
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
                databases: [externalPayload.databases[0], externalPayload.databases[0]],
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

        const lowerReclaimability = {
            ...externalPayload.tableHealth[0],
            estimatedReclaimableBytes: 1024,
            table: "lower-reclaimability",
        };
        const higherReclaimability = {
            ...externalPayload.tableHealth[0],
            estimatedReclaimableBytes: 2048,
            table: "higher-reclaimability",
        };
        const reclaimabilityPayload = {
            ...externalPayload,
            summary: {
                ...externalPayload.summary,
                maintenance: {
                    ...externalPayload.summary.maintenance,
                    assessedPhysicalBytes: 8192,
                    estimatedReclaimableBytes: 3072,
                    estimatedReclaimablePercent: 37.5,
                },
            },
        };
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...reclaimabilityPayload,
                tableHealth: [higherReclaimability, lowerReclaimability],
            }).success
        ).toBe(true);
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...reclaimabilityPayload,
                tableHealth: [lowerReclaimability, higherReclaimability],
            }).success
        ).toBe(false);

        const oversizedDatabaseInventory = [
            ...externalPayload.databases,
            ...Array.from(
                {
                    length:
                        databaseObservabilityDatabaseMaximum -
                        externalPayload.databases.length +
                        1,
                },
                (_, index) => ({
                    ...externalPayload.databases[0],
                    name: `dynamic_${String(index).padStart(2, "0")}`,
                })
            ),
        ].toSorted((left, right) => left.name.localeCompare(right.name));
        expect(oversizedDatabaseInventory).toHaveLength(
            databaseObservabilityDatabaseMaximum + 1
        );
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...externalPayload,
                databases: oversizedDatabaseInventory,
            }).success
        ).toBe(false);

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
        const statementAssessmentUnavailable = {
            ...externalPayload,
            statements: [],
            summary: {
                ...externalPayload.summary,
                maintenance: {
                    ...externalPayload.summary.maintenance,
                    status: "not-assessed" as const,
                },
                pgStatStatementsEnabled: false,
            },
        };
        expect(
            v.safeParse(
                databaseObservabilityCachePayloadSchema,
                statementAssessmentUnavailable
            ).success
        ).toBe(true);
        expect(
            v.safeParse(databaseObservabilityCachePayloadSchema, {
                ...statementAssessmentUnavailable,
                summary: {
                    ...statementAssessmentUnavailable.summary,
                    maintenance: {
                        ...statementAssessmentUnavailable.summary.maintenance,
                        status: "healthy",
                    },
                },
            }).success
        ).toBe(false);

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

    test("combines absolute and relative SQLite VACUUM review thresholds", () => {
        const mebibyte = 1024 * 1024;
        expect(sqliteReusableSpaceRequiresVacuumReview(1024 * mebibyte, 1)).toBe(true);
        expect(sqliteReusableSpaceRequiresVacuumReview(256 * mebibyte, 50)).toBe(true);
        expect(sqliteReusableSpaceRequiresVacuumReview(256 * mebibyte - 1, 100)).toBe(
            false
        );
        expect(sqliteReusableSpaceRequiresVacuumReview(256 * mebibyte, 49.99)).toBe(
            false
        );
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
