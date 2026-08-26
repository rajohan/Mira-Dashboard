import * as v from "valibot";

import {
    type BackupCachePayload,
    type BackupKopiaSourceSummary,
    type BackupType,
    backupCountMaximum,
    backupKopiaSourceIdSchema,
    backupKopiaSourceMaximum,
    backupKopiaSnapshotMaximum,
    backupRetentionReasonMaximum,
    backupSourceRevisionSchema,
    backupTypeSchema,
} from "./backups.ts";

/** Normalized provider-owned status document before Dashboard projection. */
export const backupWrapperStatusMaximumBytes = 512 * 1024;
import { jobRunIdSchema } from "./jobModel.ts";

const wrapperCountSchema = v.pipe(
    v.number("Backup wrapper count is invalid"),
    v.safeInteger("Backup wrapper count is invalid"),
    v.minValue(0, "Backup wrapper count is invalid"),
    v.maxValue(backupCountMaximum, "Backup wrapper count is outside its budget")
);
const wrapperTimestampSchema = v.pipe(
    v.number("Backup wrapper timestamp is invalid"),
    v.safeInteger("Backup wrapper timestamp is invalid"),
    v.minValue(0, "Backup wrapper timestamp is invalid")
);
const wrapperByteCountSchema = v.pipe(
    v.number("Backup wrapper byte count is invalid"),
    v.safeInteger("Backup wrapper byte count is invalid"),
    v.minValue(0, "Backup wrapper byte count is invalid")
);
const wrapperDisplayTextSchema = v.pipe(
    v.string("Backup wrapper display text is invalid"),
    v.minLength(1, "Backup wrapper display text is invalid"),
    v.maxLength(256, "Backup wrapper display text is outside its budget"),
    v.check((value) => !value.includes("\0"), "Backup wrapper display text is invalid")
);

export const backupWrapperProtocol = "mira-dashboard-backup.v2" as const;
const backupWrapperBaseEntries = {
    idle: v.boolean("Backup wrapper idle state is invalid"),
    protocol: v.literal(backupWrapperProtocol),
};
const backupWrapperKopiaSnapshotSchema = v.strictObject({
    completedAtMs: wrapperTimestampSchema,
    description: v.optional(wrapperDisplayTextSchema),
    fileCount: v.optional(wrapperCountSchema),
    retentionReasons: v.pipe(
        v.array(wrapperDisplayTextSchema),
        v.maxLength(
            backupRetentionReasonMaximum,
            "Backup wrapper retention reasons are outside their budget"
        )
    ),
    sizeBytes: v.optional(wrapperByteCountSchema),
});
const backupWrapperKopiaSourceSchema = v.strictObject({
    id: backupKopiaSourceIdSchema,
    latestCompletedAtMs: v.optional(wrapperTimestampSchema),
    latestFileCount: v.optional(wrapperCountSchema),
    latestSizeBytes: v.optional(wrapperByteCountSchema),
    snapshots: v.pipe(
        v.array(backupWrapperKopiaSnapshotSchema),
        v.maxLength(
            backupKopiaSnapshotMaximum,
            "Backup wrapper snapshots are outside their budget"
        )
    ),
    snapshotCount: wrapperCountSchema,
});
const backupWrapperKopiaSourceInventorySchema = v.pipe(
    backupWrapperKopiaSourceSchema,
    v.check(
        (source) =>
            source.snapshots.length ===
            Math.min(source.snapshotCount, backupKopiaSnapshotMaximum),
        "Backup wrapper snapshot inventory is incomplete"
    )
);
const backupWrapperKopiaStatusSchema = v.strictObject({
    ...backupWrapperBaseEntries,
    sources: v.pipe(
        v.array(
            backupWrapperKopiaSourceInventorySchema,
            "Backup wrapper sources are invalid"
        ),
        v.minLength(1, "Backup wrapper sources are invalid"),
        v.maxLength(
            backupKopiaSourceMaximum,
            "Backup wrapper sources are outside their budget"
        ),
        v.check(
            (sources) =>
                sources.every(
                    (source, index) => index === 0 || sources[index - 1]!.id < source.id
                ),
            "Backup wrapper sources are not canonical"
        )
    ),
    type: v.literal("kopia"),
});
const backupWrapperWalgStatusSchema = v.strictObject({
    ...backupWrapperBaseEntries,
    backupCount: wrapperCountSchema,
    latestCompletedAtMs: v.optional(wrapperTimestampSchema),
    latestBackupName: v.optional(wrapperDisplayTextSchema),
    latestWalFileName: v.optional(wrapperDisplayTextSchema),
    type: v.literal("walg"),
});

/** Strict normalized output emitted by the fixed provider-owned status wrapper. */
export const backupWrapperStatusSchema = v.pipe(
    v.variant("type", [backupWrapperKopiaStatusSchema, backupWrapperWalgStatusSchema]),
    v.check(
        (status) =>
            new TextEncoder().encode(JSON.stringify(status)).byteLength <=
            backupWrapperStatusMaximumBytes,
        "Backup wrapper output is outside its byte budget"
    )
);
export type BackupWrapperStatus = v.InferOutput<typeof backupWrapperStatusSchema>;

/** Minimal proof emitted only after the fixed wrapper knows a run settled successfully. */
export const backupWrapperRunResultSchema = v.variant("type", [
    v.strictObject({
        protocol: v.literal(backupWrapperProtocol),
        status: v.literal("completed"),
        type: v.literal("kopia"),
    }),
    v.strictObject({
        protocol: v.literal(backupWrapperProtocol),
        status: v.literal("completed"),
        type: v.literal("walg"),
    }),
]);

const scheduledRunPayloadSchemas = ["kopia", "walg"].map((type) =>
    v.strictObject({
        operation: v.literal("run"),
        trigger: v.literal("schedule"),
        type: v.literal(type as BackupType),
    })
);
const manualRunPayloadSchemas = ["kopia", "walg"].map((type) =>
    v.strictObject({
        operation: v.literal("run"),
        sourceRevision: backupSourceRevisionSchema,
        trigger: v.literal("manual"),
        type: v.literal(type as BackupType),
    })
);
const clearAttentionPayloadSchemas = ["kopia", "walg"].map((type) =>
    v.strictObject({
        attentionRunId: jobRunIdSchema,
        operation: v.literal("clear-attention"),
        sourceRevision: backupSourceRevisionSchema,
        type: v.literal(type as BackupType),
    })
);

/** Exact durable worker payload for scheduled/manual runs and attention clearance. */
export const backupOperationJobPayloadSchema = v.variant("operation", [
    ...scheduledRunPayloadSchemas,
    ...manualRunPayloadSchemas,
    ...clearAttentionPayloadSchemas,
]);
export type BackupOperationJobPayload = v.InferOutput<
    typeof backupOperationJobPayloadSchema
>;

export function parseBackupOperationJobPayload(
    input: unknown
): BackupOperationJobPayload {
    return v.parse(backupOperationJobPayloadSchema, input);
}

export type BackupRefreshResult = Readonly<
    Record<
        BackupType,
        | Readonly<{ kind: "failed" }>
        | Readonly<{ kind: "succeeded"; payload: BackupCachePayload }>
    >
>;

export type BackupExecutionOutcome =
    | Readonly<{
          outcome: "completed";
          sourceRevision: string;
      }>
    | Readonly<{ outcome: "unknown-outcome" }>;

/** Secret-free durable result for a proven completed provider run. */
export const backupRunJobResultSchema = v.strictObject({
    completedAtMs: wrapperTimestampSchema,
    sourceRevision: backupSourceRevisionSchema,
    status: v.literal("completed"),
    type: backupTypeSchema,
});

/** Secret-free durable proof that one exact attention run was cleared. */
export const backupClearAttentionJobResultSchema = v.strictObject({
    attentionRunId: jobRunIdSchema,
    completedAtMs: wrapperTimestampSchema,
    sourceRevision: backupSourceRevisionSchema,
    status: v.literal("cleared"),
    type: backupTypeSchema,
});

/** Worker authority with no command, path, environment, or provider selector surface. */
export interface BackupJobExecutionPort {
    readonly clearAttention: (
        input: Readonly<{
            attentionRunId: string;
            sourceRevision: string;
            type: BackupType;
        }>,
        signal?: AbortSignal
    ) => Promise<BackupExecutionOutcome>;
    readonly refresh: (signal?: AbortSignal) => Promise<BackupRefreshResult>;
    readonly run: (
        input: Readonly<{
            expectedSourceRevision?: string;
            type: BackupType;
        }>,
        signal?: AbortSignal
    ) => Promise<BackupExecutionOutcome>;
}

export type BackupExecutionErrorReason =
    | "conflict"
    | "provider-busy"
    | "provider-failed"
    | "unavailable";

/** Sanitized fixed-provider failure; Docker and wrapper diagnostics remain private. */
export class BackupExecutionError extends Error {
    readonly reason: BackupExecutionErrorReason;

    constructor(reason: BackupExecutionErrorReason, options?: ErrorOptions) {
        super("Backup provider operation failed", options);
        this.name = "BackupExecutionError";
        this.reason = reason;
    }
}

/** Worker-only unresolved-attention lookup backed by the durable Jobs ledger. */
export interface BackupAttentionReader {
    readonly findUnclearedAttentionRunId: (type: BackupType) => string | undefined;
}

export interface BackupRunResult {
    readonly completedAtMs: number;
    readonly sourceRevision: string;
    readonly status: "completed";
    readonly type: BackupType;
}

export interface BackupClearAttentionResult {
    readonly attentionRunId: string;
    readonly completedAtMs: number;
    readonly sourceRevision: string;
    readonly status: "cleared";
    readonly type: BackupType;
}

/**
 * Canonicalizes wrapper source fields before public cache validation.
 *
 * @param source - The bounded source returned by the provider wrapper.
 * @param observedAtMs - The provider observation timestamp.
 * @param freshnessMaximumAgeMs - The maximum age for a current snapshot.
 * @returns A canonical public Kopia source summary.
 */
export function backupKopiaSourceSummaryFromWrapper(
    source: v.InferOutput<typeof backupWrapperKopiaSourceSchema>,
    observedAtMs: number,
    freshnessMaximumAgeMs: number
): BackupKopiaSourceSummary {
    const latestCompletedAtMs = source.latestCompletedAtMs;
    let health: BackupKopiaSourceSummary["health"] = "missing";
    if (source.snapshotCount > 0 && latestCompletedAtMs !== undefined) {
        health =
            observedAtMs - latestCompletedAtMs <= freshnessMaximumAgeMs
                ? "current"
                : "stale";
    }
    return Object.freeze({
        health,
        id: source.id,
        ...(latestCompletedAtMs === undefined ? {} : { latestCompletedAtMs }),
        ...(source.latestFileCount === undefined
            ? {}
            : { latestFileCount: source.latestFileCount }),
        ...(source.latestSizeBytes === undefined
            ? {}
            : { latestSizeBytes: source.latestSizeBytes }),
        snapshots: source.snapshots,
        snapshotCount: source.snapshotCount,
    });
}

/**
 * Parses a type at dynamic worker boundaries without widening provider authority.
 *
 * @param input - The untrusted boundary value.
 * @returns The validated backup type.
 */
export function parseBackupType(input: unknown): BackupType {
    return v.parse(backupTypeSchema, input);
}
