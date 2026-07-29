import * as v from "valibot";

import {
    finiteNumberSchema,
    nonNegativeIntegerSchema,
    parseContract,
    successLiteralSchema,
} from "./runtime";

export const BACKUP_TYPES = ["kopia", "walg"] as const;
export const BACKUP_JOB_STATUSES = [
    "cancelled",
    "done",
    "failed",
    "needs_attention",
    "running",
] as const;

export const backupTypeSchema = v.picklist(BACKUP_TYPES);
export const backupJobStatusSchema = v.picklist(BACKUP_JOB_STATUSES);

export const backupJobSchema = v.strictObject({
    code: v.optional(finiteNumberSchema),
    endedAt: v.optional(finiteNumberSchema),
    id: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    startedAt: finiteNumberSchema,
    status: backupJobStatusSchema,
    stderr: v.string(),
    stdout: v.string(),
    type: backupTypeSchema,
});

export const backupStatusResponseSchema = v.strictObject({
    job: v.optional(backupJobSchema),
});

export const backupRunResponseSchema = v.strictObject({
    isOk: successLiteralSchema,
    job: backupJobSchema,
});

export const backupClearResponseSchema = v.strictObject({
    cleared: backupJobSchema,
    isOk: successLiteralSchema,
});

/** Kopia owns this evolving payload, so only fields consumed by the UI are retained. */
export const kopiaSnapshotSchema = v.object({
    description: v.optional(v.string()),
    endTime: v.optional(v.string()),
    errorCount: v.optional(finiteNumberSchema),
    fileCount: v.optional(finiteNumberSchema),
    id: v.optional(v.string()),
    ignoredErrorCount: v.optional(finiteNumberSchema),
    path: v.optional(v.string()),
    retentionReason: v.array(v.string()),
    startTime: v.optional(v.string()),
    totalSize: v.optional(finiteNumberSchema),
});

export const kopiaSnapshotGroupSchema = v.object({
    latest: v.optional(kopiaSnapshotSchema),
    path: v.optional(v.string()),
    snapshotCount: nonNegativeIntegerSchema,
    snapshots: v.array(kopiaSnapshotSchema),
});

const kopiaStaleSnapshotSchema = v.object({
    endTime: v.optional(v.string()),
    missing: v.optional(v.boolean()),
    path: v.optional(v.string()),
});

export const kopiaBackupCacheSchema = v.strictObject({
    checkedAt: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    isOk: v.boolean(),
    latest: v.array(kopiaSnapshotSchema),
    snapshotsByPath: v.array(kopiaSnapshotGroupSchema),
    stale: v.array(kopiaStaleSnapshotSchema),
    tool: v.literal("kopia"),
});

/** WAL-G owns this evolving payload, so only fields consumed by the UI are retained. */
export const walgBackupSchema = v.object({
    backupName: v.optional(v.string()),
    finishTime: v.optional(v.string()),
    freshnessTime: v.optional(v.string()),
    modified: v.optional(v.string()),
    startTime: v.optional(v.string()),
    storageName: v.optional(v.string()),
    time: v.optional(v.string()),
    walFileName: v.optional(v.string()),
});

export const walgBackupCacheSchema = v.strictObject({
    backupCount: nonNegativeIntegerSchema,
    backups: v.array(walgBackupSchema),
    checkedAt: v.pipe(v.string(), v.trim(), v.nonEmpty()),
    isOk: v.boolean(),
    latest: v.optional(walgBackupSchema),
    latestAgeHours: v.optional(finiteNumberSchema),
    stale: v.boolean(),
    tool: v.literal("wal-g"),
});

export type BackupType = v.InferOutput<typeof backupTypeSchema>;
export type BackupJobStatus = v.InferOutput<typeof backupJobStatusSchema>;
export type BackupJob = v.InferOutput<typeof backupJobSchema>;
export type BackupStatusResponse = v.InferOutput<typeof backupStatusResponseSchema>;
export type BackupRunResponse = v.InferOutput<typeof backupRunResponseSchema>;
export type BackupClearResponse = v.InferOutput<typeof backupClearResponseSchema>;
export type KopiaSnapshot = v.InferOutput<typeof kopiaSnapshotSchema>;
export type KopiaSnapshotGroup = v.InferOutput<typeof kopiaSnapshotGroupSchema>;
export type KopiaBackupCache = v.InferOutput<typeof kopiaBackupCacheSchema>;
export type WalgBackup = v.InferOutput<typeof walgBackupSchema>;
export type WalgBackupCache = v.InferOutput<typeof walgBackupCacheSchema>;

/**
 * Parses one backup job returned by the Dashboard API.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed one backup job returned by the Dashboard API.
 */
export function parseBackupJob(value: unknown, path = "backupJob"): BackupJob {
    return parseContract(backupJobSchema, value, path);
}

/**
 * Parses the current backup status at the browser HTTP trust boundary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the current backup status at the browser HTTP trust boundary.
 */
export function parseBackupStatusResponse(
    value: unknown,
    path = "backupStatus"
): BackupStatusResponse {
    return parseContract(backupStatusResponseSchema, value, path);
}

export function parseBackupRunResponse(
    value: unknown,
    path = "backupRun"
): BackupRunResponse {
    return parseContract(backupRunResponseSchema, value, path);
}

export function parseBackupClearResponse(
    value: unknown,
    path = "backupClear"
): BackupClearResponse {
    return parseContract(backupClearResponseSchema, value, path);
}

/**
 * Parses the cached Kopia snapshot summary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cached Kopia snapshot summary.
 */
export function parseKopiaBackupCache(
    value: unknown,
    path = "kopiaBackup"
): KopiaBackupCache {
    return parseContract(kopiaBackupCacheSchema, value, path);
}

/**
 * Parses the cached WAL-G backup summary.
 * @param value Value to process.
 * @param path File or resource path.
 * @returns Parsed the cached WAL-G backup summary.
 */
export function parseWalgBackupCache(
    value: unknown,
    path = "walgBackup"
): WalgBackupCache {
    return parseContract(walgBackupCacheSchema, value, path);
}
