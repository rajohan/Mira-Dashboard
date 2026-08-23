import { getTime } from "date-fns";

import {
    type SqliteLifecycleObservation,
    sqliteMaintenanceHistoryMaximum,
} from "../../../contracts/database.ts";
import { readVerifiedSqliteMaintenanceInventory } from "../../database/runtime/databaseSnapshot.ts";
import {
    sqliteMaintenanceJobActionKey,
    sqliteMaintenanceJobScheduleId,
} from "../jobs/actionRegistry.ts";
import type { JobRepositoryReader } from "../jobs/repository.ts";

/** Maximum time a successfully decoded lifecycle source can survive a later read failure. */
export const sqliteLifecycleLastKnownGoodMs = 24 * 60 * 60_000;

export interface SqliteLifecycleReader {
    read(): Promise<SqliteLifecycleObservation>;
}

export interface SqliteLifecycleReaderOptions {
    readonly inventory?: typeof readVerifiedSqliteMaintenanceInventory;
    readonly lastKnownGoodMs?: number;
    readonly nowMs?: () => number;
    readonly repository: Pick<
        JobRepositoryReader,
        "findLatestSuccessfulRunForSchedule" | "findSchedule" | "listScheduleRuns"
    >;
    readonly stateDirectory: string;
}

type BackupInventory = SqliteLifecycleObservation["backupInventory"];
type Maintenance = SqliteLifecycleObservation["maintenance"];
type RestoreVerification = SqliteLifecycleObservation["restoreVerification"];
type AvailableInventory = Extract<BackupInventory, { readonly state: "available" }>;
type AvailableMaintenance = Extract<Maintenance, { readonly state: "available" }>;
type VerifiedRestore = Extract<RestoreVerification, { readonly state: "verified" }>;

interface Retained<T> {
    readonly failedAtMs?: number;
    readonly value: T;
}

function checkedTime(nowMs: () => number): number {
    const value = nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError("SQLite lifecycle clock is invalid");
    }
    return value;
}

function retainedInventory(
    retained: Retained<AvailableInventory> | undefined,
    checkedAtMs: number,
    maximumAgeMs: number
): BackupInventory {
    if (
        retained === undefined ||
        checkedAtMs - retained.value.observedAtMs > maximumAgeMs
    ) {
        return { reason: "inventory-unavailable", state: "unavailable" };
    }
    return {
        ...retained.value,
        staleSinceMs: retained.failedAtMs ?? checkedAtMs,
        state: "last-known-good",
    };
}

function retainedRestore(
    retained: Retained<VerifiedRestore> | undefined,
    checkedAtMs: number,
    maximumAgeMs: number
): RestoreVerification {
    if (
        retained === undefined ||
        checkedAtMs - retained.value.observedAtMs > maximumAgeMs
    ) {
        return { reason: "verification-unavailable", state: "unavailable" };
    }
    return {
        ...retained.value,
        staleSinceMs: retained.failedAtMs ?? checkedAtMs,
        state: "last-known-good",
    };
}

function retainedMaintenance(
    retained: Retained<AvailableMaintenance> | undefined,
    checkedAtMs: number,
    maximumAgeMs: number
): Maintenance {
    if (
        retained === undefined ||
        checkedAtMs - retained.value.observedAtMs > maximumAgeMs
    ) {
        return { reason: "maintenance-unavailable", state: "unavailable" };
    }
    return {
        ...retained.value,
        staleSinceMs: retained.failedAtMs ?? checkedAtMs,
        state: "last-known-good",
    };
}

function requireCanonicalSchedule(
    record: NonNullable<ReturnType<JobRepositoryReader["findSchedule"]>>
): void {
    const schedule = record.schedule;
    if (
        schedule.id !== sqliteMaintenanceJobScheduleId ||
        schedule.actionKey !== sqliteMaintenanceJobActionKey ||
        schedule.actionPayloadJson !== "{}" ||
        schedule.attemptLimit !== 1 ||
        schedule.cancellationPolicy !== "never" ||
        schedule.scheduleKind !== "daily" ||
        schedule.timeOfDay !== "02:40" ||
        schedule.timeZone !== "Europe/Oslo" ||
        schedule.intervalMs !== null ||
        schedule.cronExpression !== null ||
        schedule.resourceClass !== "host-heavy" ||
        schedule.resourceKeysJson !== '["database"]' ||
        schedule.retrySafe
    ) {
        throw new Error("SQLite maintenance schedule is invalid");
    }
}

function projectMaintenance(
    repository: SqliteLifecycleReaderOptions["repository"],
    observedAtMs: number
): AvailableMaintenance {
    const relation = repository.findSchedule(sqliteMaintenanceJobScheduleId);
    if (relation === undefined) {
        throw new Error("SQLite maintenance schedule is unavailable");
    }
    requireCanonicalSchedule(relation);
    const records = repository.listScheduleRuns({
        id: sqliteMaintenanceJobScheduleId,
        limit: sqliteMaintenanceHistoryMaximum,
    });
    if (records.length > sqliteMaintenanceHistoryMaximum + 1) {
        throw new Error("SQLite maintenance history is outside its budget");
    }
    const latestSuccessful = repository.findLatestSuccessfulRunForSchedule(
        sqliteMaintenanceJobScheduleId
    );
    if (
        latestSuccessful !== undefined &&
        (latestSuccessful.actionKey !== sqliteMaintenanceJobActionKey ||
            latestSuccessful.scheduledJobId !== sqliteMaintenanceJobScheduleId ||
            latestSuccessful.payloadJson !== "{}" ||
            latestSuccessful.state !== "succeeded" ||
            latestSuccessful.finishedAt === null ||
            getTime(latestSuccessful.finishedAt) > observedAtMs)
    ) {
        throw new Error("SQLite maintenance success history is invalid");
    }
    const runs = records.slice(0, sqliteMaintenanceHistoryMaximum).map((record) => {
        if (
            record.actionKey !== sqliteMaintenanceJobActionKey ||
            record.scheduledJobId !== sqliteMaintenanceJobScheduleId ||
            record.payloadJson !== "{}"
        ) {
            throw new Error("SQLite maintenance history is invalid");
        }
        return Object.freeze({
            ...(record.finishedAt === null
                ? {}
                : { finishedAtMs: getTime(record.finishedAt) }),
            queuedAtMs: getTime(record.queuedAt),
            runId: record.id,
            ...(record.firstStartedAt === null
                ? {}
                : { startedAtMs: getTime(record.firstStartedAt) }),
            state: record.state,
        });
    });
    return {
        enabled: relation.schedule.enabled,
        ...(latestSuccessful?.finishedAt === null ||
        latestSuccessful?.finishedAt === undefined
            ? {}
            : { latestSuccessfulAtMs: getTime(latestSuccessful.finishedAt) }),
        ...(relation.schedule.enabled && relation.schedule.nextRunAt !== null
            ? { nextRunAtMs: getTime(relation.schedule.nextRunAt) }
            : {}),
        observedAtMs,
        runs,
        schedule: {
            timeOfDay: "02:40" as const,
            timeZone: "Europe/Oslo" as const,
        },
        state: "available" as const,
    };
}

/**
 * Combines the exact immutable backup namespace and the one code-owned schedule.
 * Each source retains its own bounded path-free last-known-good observation.
 * @param options Fixed inventory, repository, schedule, clock, and LKG dependencies.
 * @returns Bounded SQLite lifecycle reader.
 */
export function createSqliteLifecycleReader(
    options: SqliteLifecycleReaderOptions
): SqliteLifecycleReader {
    const nowMs = options.nowMs ?? Date.now;
    const readInventory = options.inventory ?? readVerifiedSqliteMaintenanceInventory;
    const maximumAgeMs = options.lastKnownGoodMs ?? sqliteLifecycleLastKnownGoodMs;
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1) {
        throw new RangeError("SQLite lifecycle retention is invalid");
    }
    let inventoryLkg: Retained<AvailableInventory> | undefined;
    let restoreLkg: Retained<VerifiedRestore> | undefined;
    let maintenanceLkg: Retained<AvailableMaintenance> | undefined;

    return Object.freeze({
        async read(): Promise<SqliteLifecycleObservation> {
            const checkedAtMs = checkedTime(nowMs);
            let backupInventory: BackupInventory;
            let restoreVerification: RestoreVerification;
            try {
                const inventory = await readInventory(options.stateDirectory);
                backupInventory = {
                    backups: [...inventory.backups],
                    observedAtMs: checkedAtMs,
                    state: "available" as const,
                    totalBytes: inventory.totalBytes,
                };
                inventoryLkg = { value: backupInventory };
                const latest = inventory.backups.find(
                    (backup) =>
                        backup.verificationLevel === "restore-copy-verified" &&
                        backup.restoreVerifiedAtMs !== undefined
                );
                const verifiedAtMs = latest?.restoreVerifiedAtMs;
                if (latest === undefined || verifiedAtMs === undefined) {
                    restoreVerification = {
                        reason: "no-verified-backup" as const,
                        state: "unavailable" as const,
                    };
                    restoreLkg = undefined;
                } else {
                    restoreVerification = {
                        backupBytes: latest.bytes,
                        backupCreatedAtMs: latest.createdAtMs,
                        observedAtMs: checkedAtMs,
                        state: "verified" as const,
                        verifiedAtMs,
                    };
                    restoreLkg = { value: restoreVerification };
                }
            } catch {
                inventoryLkg =
                    inventoryLkg === undefined
                        ? undefined
                        : {
                              failedAtMs: inventoryLkg.failedAtMs ?? checkedAtMs,
                              value: inventoryLkg.value,
                          };
                restoreLkg =
                    restoreLkg === undefined
                        ? undefined
                        : {
                              failedAtMs: restoreLkg.failedAtMs ?? checkedAtMs,
                              value: restoreLkg.value,
                          };
                backupInventory = retainedInventory(
                    inventoryLkg,
                    checkedAtMs,
                    maximumAgeMs
                );
                restoreVerification = retainedRestore(
                    restoreLkg,
                    checkedAtMs,
                    maximumAgeMs
                );
            }

            let maintenance: Maintenance;
            try {
                maintenance = projectMaintenance(options.repository, checkedAtMs);
                maintenanceLkg = { value: maintenance };
            } catch {
                maintenanceLkg =
                    maintenanceLkg === undefined
                        ? undefined
                        : {
                              failedAtMs: maintenanceLkg.failedAtMs ?? checkedAtMs,
                              value: maintenanceLkg.value,
                          };
                maintenance = retainedMaintenance(
                    maintenanceLkg,
                    checkedAtMs,
                    maximumAgeMs
                );
            }
            return {
                backupInventory,
                maintenance,
                restoreVerification,
            };
        },
    });
}
