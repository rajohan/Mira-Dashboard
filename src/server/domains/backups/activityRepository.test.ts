import { describe, expect, test } from "bun:test";

import { jobRuns } from "../../database/schema/jobRuns.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { backupKopiaRunJobActionKey } from "../jobs/actionRegistry.ts";
import { createJobRepository } from "../jobs/repository.ts";
import { createBackupActivityRepository } from "./activityRepository.ts";

const userId = "019fe200-0000-7000-8000-000000000001";
const sourceRevision = "a".repeat(64);
type StoredJobRunInsert = typeof jobRuns.$inferInsert;

function runId(index: number): string {
    return `019fe200-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function terminalRun(
    index: number,
    terminalCode: string,
    overrides: Partial<StoredJobRunInsert> = {}
): StoredJobRunInsert {
    const queuedAt = new Date(1000 + index * 10);
    const startedAt = new Date(queuedAt.getTime() + 1);
    const finishedAt = new Date(queuedAt.getTime() + 2);
    return {
        actionKey: backupKopiaRunJobActionKey,
        attemptCount: 1,
        attemptLimit: 1,
        availableAt: queuedAt,
        cancellationPolicy: "never",
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: "Kopia backup",
        enqueueSha256: index.toString(16).padStart(64, "0"),
        finishedAt,
        firstStartedAt: startedAt,
        heartbeatAt: null,
        id: runId(index),
        idempotencyKey: index.toString(16).padStart(32, "0"),
        lastAttemptStartedAt: startedAt,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        payloadJson: JSON.stringify({
            operation: "run",
            sourceRevision,
            trigger: "manual",
            type: "kopia",
        }),
        priority: 10,
        queuedAt,
        requestedById: userId,
        requestedByKind: "user",
        requiredWorkerReleaseId: "b".repeat(40),
        resourceClass: "exclusive",
        resourceKeysJson: '["backup.heavy-io","docker.engine"]',
        resultJson: null,
        retrySafe: false,
        scheduledForAt: null,
        scheduledJobId: null,
        scheduledJobVersion: null,
        state: "failed",
        terminalCode,
        terminalMessage: "Backup operation failed.",
        timeoutMs: 6 * 60 * 60_000,
        triggerType: "manual",
        updatedAt: finishedAt,
        ...overrides,
    };
}

describe("backup activity repository", () => {
    test("retains unresolved attention beyond bounded Jobs history until exact clearance", async () => {
        const database = await openFreshMigratedDatabase();
        const repository = createJobRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const originalAttention = terminalRun(1, "operation-outcome-unknown");
        const newerFailures = Array.from({ length: 101 }, (_, offset) =>
            terminalRun(offset + 2, "backup/attention-blocked")
        );
        try {
            const plan = database.sqlite
                .query<{ detail: string }, []>(
                    `EXPLAIN QUERY PLAN
                     SELECT candidate.id FROM job_runs AS candidate
                     WHERE candidate.action_key = 'backup.kopia.run'
                       AND (candidate.state = 'timed-out' OR
                            (candidate.state = 'failed' AND candidate.terminal_code IN
                             ('action-timeout', 'operation-outcome-unknown', 'worker/lease-expired')))
                       AND NOT EXISTS (
                         SELECT clear_run.id FROM job_runs AS clear_run
                         WHERE clear_run.action_key = 'backup.clear-attention'
                           AND clear_run.state = 'succeeded'
                           AND clear_run.queued_at >= candidate.queued_at
                           AND json_extract(clear_run.result_json, '$.status') = 'cleared'
                           AND json_extract(clear_run.result_json, '$.type') = 'kopia'
                           AND json_extract(clear_run.result_json, '$.attentionRunId') = candidate.id
                       )
                     ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT 1`
                )
                .all()
                .map(({ detail }) => detail)
                .join("\n");
            expect(plan).toContain("job_runs_backup_attention_history_idx");
            expect(plan).toContain("job_runs_backup_clear_history_idx");

            database.orm
                .insert(jobRuns)
                .values([originalAttention, ...newerFailures])
                .run();
            const activity = createBackupActivityRepository(database.orm, repository);

            expect(activity.read("kopia")).toMatchObject({
                jobRunId: originalAttention.id,
                state: "needs-attention",
            });

            const clear = terminalRun(104, "unused", {
                actionKey: "backup.clear-attention",
                displayName: "Clear backup attention",
                payloadJson: JSON.stringify({
                    attentionRunId: originalAttention.id,
                    operation: "clear-attention",
                    sourceRevision,
                    type: "kopia",
                }),
                resultJson: JSON.stringify({
                    attentionRunId: originalAttention.id,
                    completedAtMs: 2042,
                    sourceRevision,
                    status: "cleared",
                    type: "kopia",
                }),
                state: "succeeded",
                terminalCode: null,
                terminalMessage: null,
            });
            database.orm.insert(jobRuns).values(clear).run();

            expect(activity.isAttentionRun("kopia", originalAttention.id)).toBe(false);
            expect(activity.read("kopia")).toMatchObject({ state: "failed" });
        } finally {
            database.sqlite.close(true);
        }
    });
});
