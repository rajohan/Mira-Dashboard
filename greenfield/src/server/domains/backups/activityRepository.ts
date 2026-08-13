import { getTime } from "date-fns";
import { and, desc, eq, gte, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { alias } from "drizzle-orm/sqlite-core";
import * as v from "valibot";

import {
    type BackupActivity,
    type BackupType,
    backupActivitySchema,
} from "../../../contracts/backups.ts";
import { jobRuns } from "../../database/schema/jobRuns.ts";
import { jobRunSelectSchema } from "../../database/validation/jobRuns.ts";
import {
    backupClearAttentionJobActionKey,
    backupKopiaRunJobActionKey,
    backupWalgRunJobActionKey,
} from "../jobs/actionRegistry.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type { JobRepository } from "../jobs/repository.ts";

const attentionTerminalCodes = [
    "action-timeout",
    "operation-outcome-unknown",
    "worker/lease-expired",
] as const;

export interface BackupActivityRepository {
    readonly isAttentionRun: (type: BackupType, runId: string) => boolean;
    readonly read: (type: BackupType) => BackupActivity;
}

type BackupActivityJobReader = Pick<JobRepository, "listActionRuns">;

function actionKey(type: BackupType): string {
    return type === "kopia" ? backupKopiaRunJobActionKey : backupWalgRunJobActionKey;
}

function needsAttention(run: JobRunRecord): boolean {
    return (
        run.state === "timed-out" ||
        (run.state === "failed" &&
            run.terminalCode !== null &&
            attentionTerminalCodes.includes(
                run.terminalCode as (typeof attentionTerminalCodes)[number]
            ))
    );
}

function unresolvedAttention(
    database: SQLiteBunDatabase,
    type: BackupType
): JobRunRecord | undefined {
    const clearRuns = alias(jobRuns, "backup_attention_clear_runs");
    const matchingClear = database
        .select({ id: clearRuns.id })
        .from(clearRuns)
        .where(
            and(
                eq(clearRuns.actionKey, backupClearAttentionJobActionKey),
                eq(clearRuns.state, "succeeded"),
                isNotNull(clearRuns.resultJson),
                gte(clearRuns.queuedAt, jobRuns.queuedAt),
                sql`json_extract(${clearRuns.resultJson}, '$.status') = 'cleared'`,
                sql`json_extract(${clearRuns.resultJson}, '$.type') = ${type}`,
                sql`json_extract(${clearRuns.resultJson}, '$.attentionRunId') = ${jobRuns.id}`
            )
        );
    const row = database
        .select()
        .from(jobRuns)
        .where(
            and(
                eq(jobRuns.actionKey, actionKey(type)),
                or(
                    eq(jobRuns.state, "timed-out"),
                    and(
                        eq(jobRuns.state, "failed"),
                        inArray(jobRuns.terminalCode, [...attentionTerminalCodes])
                    )
                ),
                notExists(matchingClear)
            )
        )
        .orderBy(desc(jobRuns.updatedAt), desc(jobRuns.id))
        .limit(1)
        .get();
    if (row === undefined) return;
    const parsed = v.parse(jobRunSelectSchema, row);
    return needsAttention(parsed) ? parsed : undefined;
}

function linkedActivity(
    run: JobRunRecord,
    state: Exclude<BackupActivity["state"], "idle">
): BackupActivity {
    const base = {
        jobRunId: run.id,
        jobsUrl: `/jobs?runId=${run.id}`,
        queuedAtMs: getTime(run.queuedAt),
    };
    if (state === "queued") return v.parse(backupActivitySchema, { ...base, state });
    if (state === "running") {
        return v.parse(backupActivitySchema, {
            ...base,
            startedAtMs: getTime(run.firstStartedAt ?? run.lastAttemptStartedAt!),
            state,
        });
    }
    return v.parse(backupActivitySchema, {
        ...base,
        finishedAtMs: getTime(run.finishedAt ?? run.updatedAt),
        ...(run.firstStartedAt === null
            ? {}
            : { startedAtMs: getTime(run.firstStartedAt) }),
        state,
    });
}

/**
 * Builds a bounded Jobs-backed projection without exposing payloads or worker data.
 *
 * @param reader - Read-only access to the durable Jobs ledger.
 * @returns The immutable backup activity repository.
 */
export function createBackupActivityRepository(
    database: SQLiteBunDatabase,
    reader: BackupActivityJobReader
): BackupActivityRepository {
    const repository: BackupActivityRepository = {
        isAttentionRun(type, runId) {
            return unresolvedAttention(database, type)?.id === runId;
        },
        read(type) {
            const attention = unresolvedAttention(database, type);
            if (attention !== undefined) {
                return linkedActivity(attention, "needs-attention");
            }
            const latest = reader.listActionRuns({
                actionKey: actionKey(type),
                limit: 1,
            })[0];
            if (latest === undefined) return Object.freeze({ state: "idle" });
            switch (latest.state) {
                case "queued": {
                    return linkedActivity(latest, "queued");
                }
                case "running": {
                    return linkedActivity(latest, "running");
                }
                case "succeeded": {
                    return linkedActivity(latest, "succeeded");
                }
                case "cancelled":
                case "failed":
                case "timed-out": {
                    return linkedActivity(latest, "failed");
                }
            }
        },
    };
    return Object.freeze(repository);
}
