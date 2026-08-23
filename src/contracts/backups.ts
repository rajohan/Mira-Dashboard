import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    compareStrings,
    lowercaseSha256Schema,
    noNulStringAction,
    nonnegativeSafeIntegerSchema,
} from "../shared/validation.ts";
import { jobIdempotencyKeySchema, jobRunIdSchema } from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";
import { emptyInputSchema } from "./system.ts";

/** Fixed provider capabilities implemented by the backup vertical. */
export const backupTypes = ["kopia", "walg"] as const;
export const backupTypeSchema = v.picklist(backupTypes, "Backup type is invalid");
export type BackupType = v.InferOutput<typeof backupTypeSchema>;

/** Durable schedule identities for provider backup runs and browser deep links. */
export const backupRunScheduleIds = Object.freeze({
    kopia: "backup.kopia.run",
    walg: "backup.walg.run",
} as const satisfies Readonly<Record<BackupType, string>>);

/** Root-Compose capability labels accepted by worker discovery. */
export const backupCapabilityByType = Object.freeze({
    kopia: "kopia-v1",
    walg: "wal-g-v1",
} as const satisfies Readonly<Record<BackupType, string>>);
export const backupCapabilitySchema = v.picklist(
    [backupCapabilityByType.kopia, backupCapabilityByType.walg],
    "Backup capability is invalid"
);

/** One status action owns both independently persisted provider entries. */
export const backupStatusCacheGroupKey = "backup.status";
export const backupStatusCacheKeys = Object.freeze({
    kopia: "backup.kopia.status",
    walg: "backup.walg.status",
} as const satisfies Readonly<Record<BackupType, string>>);
export const backupStatusCacheSchemaIds = Object.freeze({
    kopia: "backup.kopia.status.v1",
    walg: "backup.walg.status.v1",
} as const satisfies Readonly<Record<BackupType, string>>);
export const backupStatusCacheSource = "docker-engine.compose.backup";
export const backupStatusCacheTtlMs = 5 * 60_000;
export const backupStatusPayloadMaximumBytes = 64 * 1024;
export const backupFreshnessMaximumAgeMs = 30 * 60 * 60_000;
export const backupKopiaSourceMaximum = 64;
export const backupKopiaSnapshotMaximum = 16;
export const backupRetentionReasonMaximum = 16;
export const backupCountMaximum = 1_000_000;

const backupTimestampSchema = timestampMillisecondsSchema("Backup timestamp is invalid");
const backupCountSchema = v.pipe(
    nonnegativeSafeIntegerSchema("Backup count is invalid"),
    v.maxValue(backupCountMaximum, "Backup count is outside its budget")
);
const backupByteCountSchema = nonnegativeSafeIntegerSchema(
    "Backup byte count is invalid"
);
const backupDisplayTextSchema = v.pipe(
    v.string("Backup display text is invalid"),
    v.minLength(1, "Backup display text is invalid"),
    v.maxLength(256, "Backup display text is outside its budget"),
    noNulStringAction("Backup display text is invalid")
);

const kopiaSnapshotSummarySchema = v.strictObject({
    completedAtMs: backupTimestampSchema,
    description: v.optional(backupDisplayTextSchema),
    fileCount: v.optional(backupCountSchema),
    retentionReasons: v.pipe(
        v.array(backupDisplayTextSchema),
        v.maxLength(
            backupRetentionReasonMaximum,
            "Backup retention reasons are outside their budget"
        )
    ),
    sizeBytes: v.optional(backupByteCountSchema),
});
export type BackupKopiaSnapshotSummary = v.InferOutput<typeof kopiaSnapshotSummarySchema>;

/** Opaque revision of the exact provider, root Compose graph, and Engine state. */
export const backupSourceRevisionSchema = lowercaseSha256Schema(
    "Backup source revision is invalid"
);

/** Safe ID derived only from a read-only `/source/<safe-id>` Kopia mount. */
export const backupKopiaSourceIdSchema = v.pipe(
    v.string("Backup source id is invalid"),
    v.minLength(1, "Backup source id is invalid"),
    v.maxLength(64, "Backup source id is invalid"),
    noNulStringAction("Backup source id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Backup source id is invalid")
);

export const backupKopiaSourceHealthStates = ["current", "missing", "stale"] as const;
export const backupKopiaSourceHealthSchema = v.picklist(
    backupKopiaSourceHealthStates,
    "Backup source health is invalid"
);

const kopiaSourceSummaryObjectSchema = v.strictObject({
    health: backupKopiaSourceHealthSchema,
    id: backupKopiaSourceIdSchema,
    latestCompletedAtMs: v.optional(backupTimestampSchema),
    latestFileCount: v.optional(backupCountSchema),
    latestSizeBytes: v.optional(backupByteCountSchema),
    snapshots: v.optional(
        v.pipe(
            v.array(kopiaSnapshotSummarySchema),
            v.maxLength(
                backupKopiaSnapshotMaximum,
                "Backup snapshots are outside their budget"
            )
        )
    ),
    snapshotCount: backupCountSchema,
});
export type BackupKopiaSourceSummary = v.InferOutput<
    typeof kopiaSourceSummaryObjectSchema
>;

/** @returns Whether one source summary has causal count, timestamp, and health fields. */
export function backupKopiaSourceSummaryIsConsistent(
    source: BackupKopiaSourceSummary,
    observedAtMs: number
): boolean {
    if (
        source.latestCompletedAtMs !== undefined &&
        source.latestCompletedAtMs > observedAtMs
    ) {
        return false;
    }
    if (source.health === "missing") {
        return (
            source.snapshotCount === 0 &&
            (source.snapshots?.length ?? 0) === 0 &&
            source.latestCompletedAtMs === undefined &&
            source.latestFileCount === undefined &&
            source.latestSizeBytes === undefined
        );
    }
    if (
        source.snapshotCount === 0 ||
        source.latestCompletedAtMs === undefined ||
        (source.snapshots !== undefined && source.snapshots.length === 0) ||
        (source.snapshots?.length ?? 0) > source.snapshotCount ||
        (source.snapshots !== undefined &&
            source.snapshots[0]?.completedAtMs !== source.latestCompletedAtMs) ||
        source.snapshots?.some(
            (snapshot, index, snapshots) =>
                snapshot.completedAtMs > observedAtMs ||
                (index > 0 &&
                    snapshots[index - 1]!.completedAtMs < snapshot.completedAtMs)
        ) === true
    ) {
        return false;
    }
    const ageMs = observedAtMs - source.latestCompletedAtMs;
    return source.health === "current"
        ? ageMs <= backupFreshnessMaximumAgeMs
        : ageMs > backupFreshnessMaximumAgeMs;
}

export function kopiaSourcesAreCanonical(sources: BackupKopiaSourceSummary[]): boolean {
    return sources.every(
        (source, index) =>
            index === 0 || compareStrings(sources[index - 1]!.id, source.id) < 0
    );
}

const kopiaSourcesSchema = v.pipe(
    v.array(kopiaSourceSummaryObjectSchema, "Backup sources are invalid"),
    v.minLength(1, "Kopia must expose at least one backup source"),
    v.maxLength(backupKopiaSourceMaximum, "Backup sources are outside their budget"),
    v.check(kopiaSourcesAreCanonical, "Backup sources are not canonical")
);

const backupCachePayloadBaseEntries = {
    observedAtMs: backupTimestampSchema,
    providerIdle: v.boolean("Backup provider idle state is invalid"),
    sourceRevision: backupSourceRevisionSchema,
};

const kopiaBackupCachePayloadObjectSchema = v.strictObject({
    ...backupCachePayloadBaseEntries,
    backupCount: backupCountSchema,
    healthy: v.boolean("Backup health is invalid"),
    sources: kopiaSourcesSchema,
    type: v.literal("kopia"),
});
export type KopiaBackupCachePayload = v.InferOutput<
    typeof kopiaBackupCachePayloadObjectSchema
>;

/** @returns Whether aggregate Kopia health exactly matches its source summaries. */
export function kopiaBackupCachePayloadIsConsistent(
    payload: KopiaBackupCachePayload
): boolean {
    return (
        payload.sources.every((source) =>
            backupKopiaSourceSummaryIsConsistent(source, payload.observedAtMs)
        ) &&
        payload.backupCount ===
            payload.sources.reduce((total, source) => total + source.snapshotCount, 0) &&
        payload.healthy === payload.sources.every(({ health }) => health === "current")
    );
}

export const kopiaBackupCachePayloadSchema = v.pipe(
    kopiaBackupCachePayloadObjectSchema,
    v.check(kopiaBackupCachePayloadIsConsistent, "Kopia backup status is inconsistent")
);

const walgBackupCachePayloadObjectSchema = v.strictObject({
    ...backupCachePayloadBaseEntries,
    backupCount: backupCountSchema,
    healthy: v.boolean("Backup health is invalid"),
    latestCompletedAtMs: v.optional(backupTimestampSchema),
    latestBackupName: v.optional(backupDisplayTextSchema),
    latestWalFileName: v.optional(backupDisplayTextSchema),
    type: v.literal("walg"),
});
export type WalgBackupCachePayload = v.InferOutput<
    typeof walgBackupCachePayloadObjectSchema
>;

/** @returns Whether aggregate WAL-G health exactly matches its latest backup. */
export function walgBackupCachePayloadIsConsistent(
    payload: WalgBackupCachePayload
): boolean {
    if (
        payload.latestCompletedAtMs !== undefined &&
        payload.latestCompletedAtMs > payload.observedAtMs
    ) {
        return false;
    }
    const current =
        payload.backupCount > 0 &&
        payload.latestCompletedAtMs !== undefined &&
        payload.observedAtMs - payload.latestCompletedAtMs <= backupFreshnessMaximumAgeMs;
    return (
        (payload.backupCount === 0) === (payload.latestCompletedAtMs === undefined) &&
        (payload.latestCompletedAtMs !== undefined ||
            (payload.latestBackupName === undefined &&
                payload.latestWalFileName === undefined)) &&
        payload.healthy === current
    );
}

export const walgBackupCachePayloadSchema = v.pipe(
    walgBackupCachePayloadObjectSchema,
    v.check(walgBackupCachePayloadIsConsistent, "WAL-G backup status is inconsistent")
);

export const backupCachePayloadSchema = v.variant("type", [
    kopiaBackupCachePayloadSchema,
    walgBackupCachePayloadSchema,
]);
export type BackupCachePayload = v.InferOutput<typeof backupCachePayloadSchema>;

export const backupActivityStates = [
    "failed",
    "idle",
    "needs-attention",
    "queued",
    "running",
    "succeeded",
] as const;
export const backupActivityStateSchema = v.picklist(
    backupActivityStates,
    "Backup activity state is invalid"
);

const backupIdleActivitySchema = v.strictObject({ state: v.literal("idle") });
const backupRunActivityBaseEntries = {
    jobRunId: jobRunIdSchema,
    jobsUrl: v.pipe(
        v.string("Backup Jobs link is invalid"),
        v.regex(/^\/jobs\?runId=[0-9a-f-]{36}$/u, "Backup Jobs link is invalid")
    ),
    queuedAtMs: backupTimestampSchema,
};
const backupQueuedActivitySchema = v.strictObject({
    ...backupRunActivityBaseEntries,
    state: v.literal("queued"),
});
const backupRunningActivitySchema = v.strictObject({
    ...backupRunActivityBaseEntries,
    startedAtMs: backupTimestampSchema,
    state: v.literal("running"),
});
const backupTerminalActivitySchemas = ["failed", "needs-attention", "succeeded"] as const;
const backupTerminalActivityVariants = backupTerminalActivitySchemas.map((state) =>
    v.strictObject({
        ...backupRunActivityBaseEntries,
        finishedAtMs: backupTimestampSchema,
        startedAtMs: v.optional(backupTimestampSchema),
        state: v.literal(state),
    })
);

const backupActivityVariantSchema = v.variant("state", [
    backupIdleActivitySchema,
    backupQueuedActivitySchema,
    backupRunningActivitySchema,
    ...backupTerminalActivityVariants,
]);
export type BackupActivity = v.InferOutput<typeof backupActivityVariantSchema>;

/** @returns Whether a run projection has an exact Jobs link and causal timestamps. */
export function backupActivityIsConsistent(activity: BackupActivity): boolean {
    if (activity.state === "idle") return true;
    if (activity.jobsUrl !== `/jobs?runId=${activity.jobRunId}`) return false;
    if (activity.state === "queued") return true;
    if (
        activity.startedAtMs !== undefined &&
        activity.startedAtMs < activity.queuedAtMs
    ) {
        return false;
    }
    return (
        activity.state === "running" ||
        activity.finishedAtMs >= (activity.startedAtMs ?? activity.queuedAtMs)
    );
}

export const backupActivitySchema = v.pipe(
    backupActivityVariantSchema,
    v.check(backupActivityIsConsistent, "Backup activity is inconsistent")
);

const backupStatusUnavailableSchema = v.strictObject({
    activity: backupActivitySchema,
    checkedAtMs: backupTimestampSchema,
    state: v.literal("unavailable"),
    type: backupTypeSchema,
});

function availableBackupStatusSchema<
    TSchema extends v.BaseSchema<unknown, BackupCachePayload, v.BaseIssue<unknown>>,
>(payloadSchema: TSchema) {
    return v.variant("state", [
        v.strictObject({
            activity: backupActivitySchema,
            checkedAtMs: backupTimestampSchema,
            payload: payloadSchema,
            state: v.literal("fresh"),
        }),
        v.strictObject({
            activity: backupActivitySchema,
            checkedAtMs: backupTimestampSchema,
            payload: payloadSchema,
            staleSinceMs: backupTimestampSchema,
            state: v.literal("last-known-good"),
        }),
    ]);
}

const kopiaBackupStatusAvailableSchema = availableBackupStatusSchema(
    kopiaBackupCachePayloadSchema
);
const walgBackupStatusAvailableSchema = availableBackupStatusSchema(
    walgBackupCachePayloadSchema
);

export type KopiaBackupStatus =
    | v.InferOutput<typeof backupStatusUnavailableSchema>
    | v.InferOutput<typeof kopiaBackupStatusAvailableSchema>;
export type WalgBackupStatus =
    | v.InferOutput<typeof backupStatusUnavailableSchema>
    | v.InferOutput<typeof walgBackupStatusAvailableSchema>;

function statusIsConsistent(
    status: KopiaBackupStatus | WalgBackupStatus,
    expectedType: BackupType
): boolean {
    if (status.state === "unavailable") return status.type === expectedType;
    if (
        status.payload.type !== expectedType ||
        status.payload.observedAtMs > status.checkedAtMs
    ) {
        return false;
    }
    return (
        status.state === "fresh" ||
        (status.staleSinceMs >= status.payload.observedAtMs &&
            status.staleSinceMs <= status.checkedAtMs)
    );
}

export function kopiaBackupStatusIsConsistent(status: KopiaBackupStatus): boolean {
    return statusIsConsistent(status, "kopia");
}

export function walgBackupStatusIsConsistent(status: WalgBackupStatus): boolean {
    return statusIsConsistent(status, "walg");
}

export const kopiaBackupStatusSchema = v.pipe(
    v.union([backupStatusUnavailableSchema, kopiaBackupStatusAvailableSchema]),
    v.check(kopiaBackupStatusIsConsistent, "Kopia status is inconsistent")
);
export const walgBackupStatusSchema = v.pipe(
    v.union([backupStatusUnavailableSchema, walgBackupStatusAvailableSchema]),
    v.check(walgBackupStatusIsConsistent, "WAL-G status is inconsistent")
);

export const backupStatusInputSchema = emptyInputSchema;

const backupOperationBaseEntries = {
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: backupSourceRevisionSchema,
};
const backupRunOperationSchemas = backupTypes.map((type) =>
    v.strictObject({
        ...backupOperationBaseEntries,
        confirmation: v.literal(`run-${type}-backup`),
        operation: v.literal("run"),
        type: v.literal(type),
    })
);
const backupClearOperationSchemas = backupTypes.map((type) =>
    v.strictObject({
        ...backupOperationBaseEntries,
        attentionRunId: jobRunIdSchema,
        confirmation: v.literal(`clear-${type}-backup-attention`),
        operation: v.literal("clear-attention"),
        type: v.literal(type),
    })
);

/** Exact recent-MFA operation request; no command, path, or provider selector exists. */
export const backupRequestOperationInputSchema = v.variant("operation", [
    ...backupRunOperationSchemas,
    ...backupClearOperationSchemas,
]);
export type BackupRequestOperationInput = v.InferOutput<
    typeof backupRequestOperationInputSchema
>;

/** Public fixed-operation inputs; procedure identity supplies type and operation. */
export const backupRunKopiaInputSchema = v.strictObject({
    confirmation: v.literal("run-kopia-backup"),
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: backupSourceRevisionSchema,
});
export const backupRunWalgInputSchema = v.strictObject({
    confirmation: v.literal("run-walg-backup"),
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: backupSourceRevisionSchema,
});
export const backupClearKopiaAttentionInputSchema = v.strictObject({
    attentionRunId: jobRunIdSchema,
    confirmation: v.literal("clear-kopia-backup-attention"),
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: backupSourceRevisionSchema,
});
export const backupClearWalgAttentionInputSchema = v.strictObject({
    attentionRunId: jobRunIdSchema,
    confirmation: v.literal("clear-walg-backup-attention"),
    idempotencyKey: jobIdempotencyKeySchema,
    sourceRevision: backupSourceRevisionSchema,
});

export const backupRequestOperationResultSchema = v.strictObject({
    jobRunId: jobRunIdSchema,
    operation: v.picklist(["clear-attention", "run"], "Backup operation is invalid"),
    queued: v.literal(true, "Backup queue result is invalid"),
    type: backupTypeSchema,
});
export type BackupRequestOperationResult = v.InferOutput<
    typeof backupRequestOperationResultSchema
>;

const backupReadAccess = {
    capabilities: ["backups:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const backupWriteAccess = {
    capabilities: ["backups:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const backupQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const backupMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

const backupOperationContractBase = {
    access: backupWriteAccess,
    domain: "backups",
    errorReasons: [
        "mfa_enrollment_required",
        "operation_outcome_unknown",
        "step_up_required",
    ],
    errors: [
        "CONFLICT",
        "FORBIDDEN",
        "NOT_FOUND",
        "SERVICE_UNAVAILABLE",
        "TOO_MANY_REQUESTS",
        "UNAUTHORIZED",
    ],
    kind: "mutation",
    output: backupRequestOperationResultSchema,
    transport: backupMutationTransport,
} as const;

/** Session-only status reads and four named recent-MFA fixed mutations. */
export const backupProcedureContracts = [
    {
        access: backupReadAccess,
        domain: "backups",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: backupStatusInputSchema,
        inputSchemaId: "backups.getKopiaStatus.input",
        kind: "query",
        name: "backups.getKopiaStatus",
        output: kopiaBackupStatusSchema,
        outputSchemaId: "backups.getKopiaStatus.output",
        summary:
            "Reads bounded Kopia aggregate and safe source status without provider identity, mount sources, raw process data, or tool output.",
        transport: backupQueryTransport,
    },
    {
        access: backupReadAccess,
        domain: "backups",
        errors: ["FORBIDDEN", "UNAUTHORIZED"],
        input: backupStatusInputSchema,
        inputSchemaId: "backups.getWalgStatus.input",
        kind: "query",
        name: "backups.getWalgStatus",
        output: walgBackupStatusSchema,
        outputSchemaId: "backups.getWalgStatus.output",
        summary:
            "Reads bounded WAL-G aggregate status without provider identity, database paths, raw process data, or tool output.",
        transport: backupQueryTransport,
    },
    {
        ...backupOperationContractBase,
        input: backupClearKopiaAttentionInputSchema,
        inputSchemaId: "backups.clearKopiaAttention.input",
        name: "backups.clearKopiaAttention",
        outputSchemaId: "backups.clearKopiaAttention.output",
        summary:
            "Queues source-fenced clearance of one exact Kopia attention run after recent MFA.",
    },
    {
        ...backupOperationContractBase,
        input: backupRunKopiaInputSchema,
        inputSchemaId: "backups.runKopia.input",
        name: "backups.runKopia",
        outputSchemaId: "backups.runKopia.output",
        summary: "Queues one source-fenced Kopia backup run after recent MFA.",
    },
    {
        ...backupOperationContractBase,
        input: backupClearWalgAttentionInputSchema,
        inputSchemaId: "backups.clearWalgAttention.input",
        name: "backups.clearWalgAttention",
        outputSchemaId: "backups.clearWalgAttention.output",
        summary:
            "Queues source-fenced clearance of one exact WAL-G attention run after recent MFA.",
    },
    {
        ...backupOperationContractBase,
        input: backupRunWalgInputSchema,
        inputSchemaId: "backups.runWalg.input",
        name: "backups.runWalg",
        outputSchemaId: "backups.runWalg.output",
        summary: "Queues one source-fenced WAL-G backup run after recent MFA.",
    },
] as const satisfies readonly ProcedureContract[];
