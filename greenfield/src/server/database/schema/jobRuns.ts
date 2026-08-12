import { asc, desc, sql } from "drizzle-orm";
import {
    check,
    index,
    integer,
    sqliteTable,
    text,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

import {
    jobRunEventMaximum,
    jobRunOutputMaximumBytes,
    jobRunPayloadEventMaximum,
} from "../../../contracts/jobModel.ts";
import {
    logMaintenanceJobActionKey,
    logMaintenanceJobPayloadIndexMaximumBytes,
} from "../../../shared/logMaintenanceUnits.ts";
import {
    boundedCanonicalBase64UrlTextCheck,
    boundedControlSafeTextCheck,
    lowercaseHexTextCheck,
    timestampMillisecondsCheck,
    uuidV7TextCheck,
} from "./checks.ts";
import {
    boundedJobKeyCheck,
    boundedJsonArrayCheck,
    boundedJsonObjectCheck,
    jobActorCheck,
    optionalJobMessageCheck,
    optionalJobTerminalCodeCheck,
    unstartedRetiredScheduleFailureCheck,
} from "./jobChecks.ts";
import { scheduledJobs } from "./scheduledJobs.ts";
import { workerInstances } from "./workerInstances.ts";

/** Durable queue, execution state, and bounded terminal snapshot for one job run. */
export const jobRuns = sqliteTable(
    "job_runs",
    {
        actionKey: text("action_key").notNull(),
        attemptCount: integer("attempt_count").notNull().default(0),
        attemptLimit: integer("attempt_limit").notNull(),
        availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
        cancellationPolicy: text("cancellation_policy", {
            enum: ["cooperative", "never", "queued-only"],
        }).notNull(),
        cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
        cancelRequestedById: text("cancel_requested_by_id"),
        cancelRequestedByKind: text("cancel_requested_by_kind", {
            enum: ["automation", "system", "user"],
        }),
        displayName: text("display_name").notNull(),
        enqueueSha256: text("enqueue_sha256").notNull(),
        eventBytes: integer("event_bytes").notNull().default(0),
        eventCount: integer("event_count").notNull().default(0),
        finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
        firstStartedAt: integer("first_started_at", { mode: "timestamp_ms" }),
        heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
        id: text("id").notNull().primaryKey(),
        idempotencyKey: text("idempotency_key").notNull(),
        lastAttemptStartedAt: integer("last_attempt_started_at", {
            mode: "timestamp_ms",
        }),
        leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
        leaseOwnerId: text("lease_owner_id").references(() => workerInstances.id, {
            onDelete: "restrict",
            onUpdate: "restrict",
        }),
        leaseToken: text("lease_token"),
        payloadEventCount: integer("payload_event_count").notNull().default(0),
        payloadJson: text("payload_json").notNull(),
        priority: integer("priority").notNull(),
        queuedAt: integer("queued_at", { mode: "timestamp_ms" }).notNull(),
        requestedById: text("requested_by_id").notNull(),
        requestedByKind: text("requested_by_kind", {
            enum: ["automation", "system", "user"],
        }).notNull(),
        resourceClass: text("resource_class", {
            enum: ["exclusive", "host-heavy", "interactive", "light", "network"],
        }).notNull(),
        resourceKeysJson: text("resource_keys_json").notNull(),
        resultJson: text("result_json"),
        retrySafe: integer("retry_safe", { mode: "boolean" }).notNull(),
        scheduledForAt: integer("scheduled_for_at", { mode: "timestamp_ms" }),
        scheduledJobId: text("scheduled_job_id").references(() => scheduledJobs.id, {
            onDelete: "restrict",
            onUpdate: "restrict",
        }),
        scheduledJobVersion: integer("scheduled_job_version"),
        state: text("state", {
            enum: ["cancelled", "failed", "queued", "running", "succeeded", "timed-out"],
        }).notNull(),
        stateVersion: integer("state_version").notNull().default(1),
        terminalCode: text("terminal_code"),
        terminalMessage: text("terminal_message"),
        timeoutMs: integer("timeout_ms").notNull(),
        triggerType: text("trigger_type", {
            enum: ["manual", "schedule", "startup", "system"],
        }).notNull(),
        updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    },
    (table) => [
        check("job_runs_action_key_check", boundedJobKeyCheck(table.actionKey, 128)),
        check(
            "job_runs_attempt_check",
            sql`${table.attemptLimit} BETWEEN 1 AND 10 AND ${table.attemptCount} BETWEEN 0 AND ${table.attemptLimit} AND ((${table.attemptCount} = 0 AND ${table.firstStartedAt} IS NULL AND ${table.lastAttemptStartedAt} IS NULL) OR (${table.attemptCount} > 0 AND ${table.firstStartedAt} IS NOT NULL AND ${table.lastAttemptStartedAt} IS NOT NULL))`
        ),
        check(
            "job_runs_available_at_check",
            sql`${timestampMillisecondsCheck(table.availableAt)} AND ${table.availableAt} >= ${table.queuedAt}`
        ),
        check(
            "job_runs_cancellation_policy_check",
            sql`${table.cancellationPolicy} IN ('cooperative', 'never', 'queued-only')`
        ),
        check(
            "job_runs_cancel_request_check",
            sql`(${table.state} <> 'cancelled' AND ${table.cancelRequestedAt} IS NULL AND ${table.cancelRequestedByKind} IS NULL AND ${table.cancelRequestedById} IS NULL) OR (${table.cancellationPolicy} <> 'never' AND ${table.cancelRequestedAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.cancelRequestedAt)} AND ${table.cancelRequestedAt} >= ${table.queuedAt} AND ${table.cancelRequestedAt} <= ${table.updatedAt} AND ${table.cancelRequestedByKind} IS NOT NULL AND ${table.cancelRequestedById} IS NOT NULL AND ${jobActorCheck(table.cancelRequestedByKind, table.cancelRequestedById, { allowSystem: true })})`
        ),
        check(
            "job_runs_display_name_check",
            sql`${boundedControlSafeTextCheck(table.displayName, 160)} AND length(CAST(${table.displayName} AS BLOB)) <= 640`
        ),
        check(
            "job_runs_enqueue_sha256_check",
            lowercaseHexTextCheck(table.enqueueSha256, 64)
        ),
        check(
            "job_runs_event_budget_check",
            sql`${table.eventCount} BETWEEN 0 AND ${sql.raw(String(jobRunEventMaximum))} AND ${table.payloadEventCount} BETWEEN 0 AND ${sql.raw(String(jobRunPayloadEventMaximum))} AND ${table.payloadEventCount} <= ${table.eventCount} AND ${table.eventBytes} BETWEEN 0 AND ${sql.raw(String(jobRunOutputMaximumBytes))}`
        ),
        check("job_runs_id_check", uuidV7TextCheck(table.id)),
        check(
            "job_runs_idempotency_key_check",
            boundedCanonicalBase64UrlTextCheck(table.idempotencyKey, 32, 128)
        ),
        check(
            "job_runs_lease_check",
            sql`(${table.state} <> 'running' AND ${table.leaseOwnerId} IS NULL AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.heartbeatAt} IS NULL) OR (${table.state} = 'running' AND ${table.leaseOwnerId} IS NOT NULL AND ${table.leaseToken} IS NOT NULL AND ${uuidV7TextCheck(table.leaseToken)} AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.heartbeatAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.heartbeatAt)} AND ${timestampMillisecondsCheck(table.leaseExpiresAt)} AND ${table.heartbeatAt} >= ${table.lastAttemptStartedAt} AND ${table.leaseExpiresAt} > ${table.heartbeatAt})`
        ),
        check(
            "job_runs_payload_json_check",
            boundedJsonObjectCheck(table.payloadJson, 65_536)
        ),
        check("job_runs_priority_check", sql`${table.priority} BETWEEN -100 AND 100`),
        check(
            "job_runs_requested_actor_check",
            jobActorCheck(table.requestedByKind, table.requestedById, {
                allowSystem: true,
            })
        ),
        check(
            "job_runs_resource_class_check",
            sql`${table.resourceClass} IN ('exclusive', 'host-heavy', 'interactive', 'light', 'network')`
        ),
        check(
            "job_runs_resource_keys_json_check",
            boundedJsonArrayCheck(table.resourceKeysJson, 4096)
        ),
        check(
            "job_runs_result_json_check",
            sql`${table.resultJson} IS NULL OR (${boundedJsonObjectCheck(table.resultJson, 65_536)})`
        ),
        check("job_runs_retry_safe_check", sql`${table.retrySafe} IN (0, 1)`),
        check(
            "job_runs_schedule_check",
            sql`(${table.triggerType} = 'schedule' AND ${table.scheduledJobId} IS NOT NULL AND ${table.scheduledJobVersion} BETWEEN 1 AND 9007199254740991 AND ${table.scheduledForAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.scheduledForAt)} AND ${table.scheduledForAt} <= ${table.queuedAt}) OR (${table.triggerType} = 'manual' AND (((${table.scheduledJobId} IS NOT NULL AND ${table.scheduledJobVersion} BETWEEN 1 AND 9007199254740991) OR (${table.scheduledJobId} IS NULL AND ${table.scheduledJobVersion} IS NULL)) AND ${table.scheduledForAt} IS NULL)) OR (${table.triggerType} IN ('startup', 'system') AND ${table.scheduledJobId} IS NULL AND ${table.scheduledJobVersion} IS NULL AND ${table.scheduledForAt} IS NULL)`
        ),
        check(
            "job_runs_state_check",
            sql`${table.state} IN ('cancelled', 'failed', 'queued', 'running', 'succeeded', 'timed-out') AND ((${table.state} = 'queued' AND ${table.finishedAt} IS NULL AND ${table.resultJson} IS NULL AND ${table.terminalCode} IS NULL AND ${table.terminalMessage} IS NULL) OR (${table.state} = 'running' AND ${table.attemptCount} > 0 AND ${table.finishedAt} IS NULL AND ${table.resultJson} IS NULL AND ${table.terminalCode} IS NULL AND ${table.terminalMessage} IS NULL) OR (${table.state} = 'succeeded' AND ${table.attemptCount} > 0 AND ${table.finishedAt} IS NOT NULL AND ${table.resultJson} IS NOT NULL AND ${table.terminalCode} IS NULL AND ${table.terminalMessage} IS NULL) OR (${table.state} IN ('failed', 'timed-out') AND (${table.attemptCount} > 0 OR (${unstartedRetiredScheduleFailureCheck(table)})) AND ${table.finishedAt} IS NOT NULL AND ${table.resultJson} IS NULL AND ${table.terminalCode} IS NOT NULL AND ${table.terminalMessage} IS NOT NULL) OR (${table.state} = 'cancelled' AND ${table.finishedAt} IS NOT NULL AND ${table.resultJson} IS NULL AND ${table.terminalCode} IS NOT NULL AND ${table.terminalMessage} IS NOT NULL))`
        ),
        check(
            "job_runs_state_version_check",
            sql`${table.stateVersion} BETWEEN 1 AND 9007199254740991`
        ),
        check(
            "job_runs_terminal_code_check",
            optionalJobTerminalCodeCheck(table.terminalCode, 128)
        ),
        check(
            "job_runs_terminal_message_check",
            optionalJobMessageCheck(table.terminalMessage, 2000, 8000)
        ),
        check(
            "job_runs_timeout_check",
            sql`${table.timeoutMs} BETWEEN 1000 AND 86400000`
        ),
        check(
            "job_runs_time_check",
            sql`${timestampMillisecondsCheck(table.queuedAt)} AND ${timestampMillisecondsCheck(table.updatedAt)} AND ${table.updatedAt} >= ${table.queuedAt} AND (${table.firstStartedAt} IS NULL OR (${timestampMillisecondsCheck(table.firstStartedAt)} AND ${table.firstStartedAt} BETWEEN ${table.queuedAt} AND ${table.updatedAt})) AND (${table.lastAttemptStartedAt} IS NULL OR (${table.firstStartedAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.lastAttemptStartedAt)} AND ${table.lastAttemptStartedAt} BETWEEN ${table.firstStartedAt} AND ${table.updatedAt})) AND (${table.heartbeatAt} IS NULL OR (${table.lastAttemptStartedAt} IS NOT NULL AND ${timestampMillisecondsCheck(table.heartbeatAt)} AND ${table.heartbeatAt} BETWEEN ${table.lastAttemptStartedAt} AND ${table.updatedAt})) AND (${table.cancelRequestedAt} IS NULL OR (${timestampMillisecondsCheck(table.cancelRequestedAt)} AND ${table.cancelRequestedAt} BETWEEN ${table.queuedAt} AND ${table.updatedAt})) AND (${table.finishedAt} IS NULL OR (${timestampMillisecondsCheck(table.finishedAt)} AND ${table.finishedAt} BETWEEN COALESCE(${table.lastAttemptStartedAt}, ${table.queuedAt}) AND ${table.updatedAt}))`
        ),
        uniqueIndex("job_runs_idempotency_unique").on(
            table.requestedByKind,
            table.requestedById,
            table.idempotencyKey
        ),
        index("job_runs_claim_idx")
            .on(
                asc(table.availableAt),
                desc(table.priority),
                asc(table.queuedAt),
                asc(table.id)
            )
            .where(sql`${table.state} = 'queued'`),
        uniqueIndex("job_runs_one_active_schedule_idx")
            .on(table.scheduledJobId)
            .where(
                sql`${table.scheduledJobId} IS NOT NULL AND ${table.state} IN ('queued', 'running')`
            ),
        index("job_runs_action_active_idx")
            .on(table.actionKey, desc(table.state), desc(table.queuedAt), desc(table.id))
            .where(sql`${table.state} IN ('queued', 'running')`),
        index("job_runs_action_payload_terminal_idx")
            .on(table.actionKey, table.payloadJson, desc(table.queuedAt), desc(table.id))
            .where(
                sql`${table.actionKey} = ${sql.raw(`'${logMaintenanceJobActionKey}'`)} AND length(CAST(${table.payloadJson} AS BLOB)) <= ${sql.raw(String(logMaintenanceJobPayloadIndexMaximumBytes))} AND ${table.state} IN ('cancelled', 'failed', 'succeeded', 'timed-out')`
            ),
        index("job_runs_queued_id_idx").on(table.queuedAt, table.id),
        index("job_runs_schedule_queued_id_idx").on(
            table.scheduledJobId,
            table.queuedAt,
            table.id
        ),
        index("job_runs_running_lease_idx")
            .on(table.leaseExpiresAt, table.id)
            .where(sql`${table.state} = 'running'`),
        index("job_runs_running_owner_id_idx")
            .on(table.leaseOwnerId, table.id)
            .where(sql`${table.state} = 'running'`),
    ]
);
