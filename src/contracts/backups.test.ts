import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    backupProcedureContracts,
    backupRequestOperationInputSchema,
    kopiaBackupCachePayloadSchema,
    kopiaBackupStatusSchema,
    walgBackupCachePayloadSchema,
} from "./backups.ts";
import {
    backupOperationJobPayloadSchema,
    backupWrapperProtocol,
    backupWrapperStatusSchema,
} from "./backupsWorker.ts";

const sourceRevision = "a".repeat(64);
const jobRunId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const idempotencyKey = "c".repeat(43);

describe("backup contracts", () => {
    test("accepts bounded aggregate Kopia and WAL-G cache payloads", () => {
        const kopia = v.parse(kopiaBackupCachePayloadSchema, {
            backupCount: 4,
            healthy: true,
            observedAtMs: 2_000_000,
            providerIdle: true,
            sourceRevision,
            sources: [
                {
                    health: "current",
                    id: "docker",
                    latestCompletedAtMs: 1_000_000,
                    latestFileCount: 12,
                    latestSizeBytes: 42,
                    snapshots: [
                        {
                            completedAtMs: 1_000_000,
                            fileCount: 12,
                            retentionReasons: ["daily-1"],
                            sizeBytes: 42,
                        },
                        { completedAtMs: 900_000, retentionReasons: ["daily-2"] },
                    ],
                    snapshotCount: 2,
                },
                {
                    health: "current",
                    id: "projects",
                    latestCompletedAtMs: 1_500_000,
                    snapshots: [
                        { completedAtMs: 1_500_000, retentionReasons: ["daily-1"] },
                        { completedAtMs: 1_400_000, retentionReasons: ["daily-2"] },
                    ],
                    snapshotCount: 2,
                },
            ],
            type: "kopia",
        });
        expect(kopia.sources.map(({ id }) => id)).toEqual(["docker", "projects"]);

        expect(
            v.parse(walgBackupCachePayloadSchema, {
                backupCount: 2,
                healthy: true,
                latestCompletedAtMs: 1_900_000,
                observedAtMs: 2_000_000,
                providerIdle: true,
                sourceRevision,
                type: "walg",
            }).backupCount
        ).toBe(2);
    });

    test("rejects noncanonical, writable-path-shaped, future, and inconsistent summaries", () => {
        const base = {
            backupCount: 1,
            healthy: true,
            observedAtMs: 2_000_000,
            providerIdle: true,
            sourceRevision,
            sources: [
                {
                    health: "current",
                    id: "safe-source",
                    latestCompletedAtMs: 1_000_000,
                    snapshots: [{ completedAtMs: 1_000_000, retentionReasons: [] }],
                    snapshotCount: 1,
                },
            ],
            type: "kopia",
        } as const;
        for (const candidate of [
            { ...base, backupCount: 2 },
            { ...base, healthy: false },
            { ...base, sources: [{ ...base.sources[0], id: "/source/docker" }] },
            {
                ...base,
                sources: [
                    { ...base.sources[0], id: "z" },
                    { ...base.sources[0], id: "a" },
                ],
            },
            {
                ...base,
                sources: [{ ...base.sources[0], latestCompletedAtMs: 2_000_001 }],
            },
        ]) {
            expect(v.safeParse(kopiaBackupCachePayloadSchema, candidate).success).toBe(
                false
            );
        }
    });

    test("accepts a complete bounded newest-first inventory for a larger repository", () => {
        const snapshots = Array.from({ length: 64 }, (_, index) => ({
            completedAtMs: 1_000_000 - index,
            retentionReasons: [],
        }));
        const payload = {
            backupCount: 65,
            healthy: true,
            observedAtMs: 2_000_000,
            providerIdle: true,
            sourceRevision,
            sources: [
                {
                    health: "current",
                    id: "docker",
                    latestCompletedAtMs: 1_000_000,
                    snapshots,
                    snapshotCount: 65,
                },
            ],
            type: "kopia",
        } as const;

        expect(v.safeParse(kopiaBackupCachePayloadSchema, payload).success).toBe(true);
        expect(
            v.safeParse(kopiaBackupCachePayloadSchema, {
                ...payload,
                sources: [{ ...payload.sources[0], snapshots: snapshots.slice(1) }],
            }).success
        ).toBe(false);
    });

    test("requires causal fresh and last-known-good envelopes with exact Jobs links", () => {
        const payload = {
            backupCount: 0,
            healthy: false,
            observedAtMs: 1000,
            providerIdle: true,
            sourceRevision,
            sources: [
                { health: "missing", id: "files", snapshots: [], snapshotCount: 0 },
            ],
            type: "kopia",
        } as const;
        const status = v.parse(kopiaBackupStatusSchema, {
            activity: {
                finishedAtMs: 1900,
                jobRunId,
                jobsUrl: `/jobs?runId=${jobRunId}`,
                queuedAtMs: 1100,
                startedAtMs: 1200,
                state: "needs-attention",
            },
            checkedAtMs: 2000,
            payload,
            staleSinceMs: 1500,
            state: "last-known-good",
        });
        expect(status.activity.state).toBe("needs-attention");
        expect(
            v.safeParse(kopiaBackupStatusSchema, {
                ...status,
                activity: { ...status.activity, jobsUrl: "/jobs" },
            }).success
        ).toBe(false);
        expect(
            v.safeParse(kopiaBackupStatusSchema, {
                ...status,
                staleSinceMs: 999,
            }).success
        ).toBe(false);
    });

    test("admits only four exact source-fenced operation variants", () => {
        const valid = [
            {
                confirmation: "run-kopia-backup",
                idempotencyKey,
                operation: "run",
                sourceRevision,
                type: "kopia",
            },
            {
                confirmation: "run-walg-backup",
                idempotencyKey,
                operation: "run",
                sourceRevision,
                type: "walg",
            },
            {
                attentionRunId: jobRunId,
                confirmation: "clear-kopia-backup-attention",
                idempotencyKey,
                operation: "clear-attention",
                sourceRevision,
                type: "kopia",
            },
            {
                attentionRunId: jobRunId,
                confirmation: "clear-walg-backup-attention",
                idempotencyKey,
                operation: "clear-attention",
                sourceRevision,
                type: "walg",
            },
        ] as const;
        for (const input of valid) {
            expect(v.parse(backupRequestOperationInputSchema, input).type).toBe(
                input.type
            );
        }
        for (const input of [
            { ...valid[0], command: "backup", confirmation: "run-kopia-backup" },
            { ...valid[0], confirmation: "run-walg-backup" },
            { ...valid[2], attentionRunId: undefined },
            { ...valid[2], cwd: "/source" },
        ]) {
            expect(v.safeParse(backupRequestOperationInputSchema, input).success).toBe(
                false
            );
        }
    });

    test("keeps scheduled/manual/clear worker payloads and wrapper output strict", () => {
        const scheduled = v.parse(backupOperationJobPayloadSchema, {
            operation: "run",
            trigger: "schedule",
            type: "walg",
        });
        expect(scheduled.operation).toBe("run");
        expect("trigger" in scheduled ? scheduled.trigger : undefined).toBe("schedule");
        expect(
            v.parse(backupWrapperStatusSchema, {
                idle: true,
                protocol: backupWrapperProtocol,
                sources: [{ id: "openclaw", snapshots: [], snapshotCount: 0 }],
                type: "kopia",
            }).type
        ).toBe("kopia");
        expect(
            v.safeParse(backupWrapperStatusSchema, {
                container: "kopia",
                idle: true,
                protocol: backupWrapperProtocol,
                sources: [{ id: "openclaw", snapshots: [], snapshotCount: 0 }],
                type: "kopia",
            }).success
        ).toBe(false);
    });

    test("declares the exact two reads and four named recent-MFA mutations", () => {
        expect(
            backupProcedureContracts.map(({ access, kind, name }) => ({
                access,
                kind,
                name,
            }))
        ).toEqual([
            {
                access: {
                    capabilities: ["backups:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "backups.getKopiaStatus",
            },
            {
                access: {
                    capabilities: ["backups:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                kind: "query",
                name: "backups.getWalgStatus",
            },
            ...[
                "backups.clearKopiaAttention",
                "backups.runKopia",
                "backups.clearWalgAttention",
                "backups.runWalg",
            ].map((name) => ({
                access: {
                    capabilities: ["backups:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                kind: "mutation",
                name,
            })),
        ]);
    });
});
