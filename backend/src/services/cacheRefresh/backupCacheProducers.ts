import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import {
    asRecord,
    nowIso,
    runCacheCommand,
    toOptionalFiniteNumber,
    toOptionalString,
} from "./cacheProducerSupport.ts";

const KOPIA_EXPECTED_SOURCE_PATHS = [
    "/source/docker",
    "/source/projects",
    "/source/openclaw",
] as const;
const BACKUP_STATUS_STALE_HOURS = 30;
const BACKUP_STATUS_MAX_TTL_HOURS = 25;

function dateGetTime(date: Date): number {
    return date.getTime();
}

function backupStatusTtlHours(timestamps: Array<string | undefined>): number {
    let ttl = BACKUP_STATUS_MAX_TTL_HOURS;
    const now = Date.now();
    for (const timestamp of timestamps) {
        if (!timestamp) {
            continue;
        }
        const timeMs = dateGetTime(new Date(timestamp));
        if (!Number.isFinite(timeMs)) {
            continue;
        }
        const remainingHours =
            BACKUP_STATUS_STALE_HOURS - Math.max(0, (now - timeMs) / 36e5);
        ttl = Math.min(ttl, Math.max(0, remainingHours));
    }
    return ttl;
}

function getDockerBin(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_BIN", "docker");
}

function firstValidTimestamp(value: string | undefined): number {
    if (!value) {
        return 0;
    }
    const parsed = dateGetTime(new Date(value));
    return Number.isFinite(parsed) ? parsed : 0;
}

function firstValidTimestampValue(
    ...values: Array<string | undefined>
): string | undefined {
    return values.find((value) => firstValidTimestamp(value) > 0) ?? undefined;
}

function summarizeKopiaSnapshot(value: unknown) {
    const snapshot = asRecord(value);
    const source = asRecord(snapshot.source);
    const stats = asRecord(snapshot.stats);
    return {
        id: toOptionalString(snapshot.id),
        path: toOptionalString(source.path),
        description: toOptionalString(snapshot.description),
        startTime: toOptionalString(snapshot.startTime),
        endTime: toOptionalString(snapshot.endTime),
        fileCount: toOptionalFiniteNumber(stats.fileCount),
        totalSize: toOptionalFiniteNumber(stats.totalSize),
        errorCount: toOptionalFiniteNumber(stats.errorCount),
        ignoredErrorCount: toOptionalFiniteNumber(stats.ignoredErrorCount),
        retentionReason: Array.isArray(snapshot.retentionReason)
            ? snapshot.retentionReason
            : [],
    };
}

function getSnapshotTime(snapshot: {
    endTime: string | undefined;
    startTime: string | undefined;
}) {
    return firstValidTimestamp(
        firstValidTimestampValue(snapshot.endTime, snapshot.startTime)
    );
}

export async function refreshKopiaBackupCache() {
    const output = await runCacheCommand(getDockerBin(), [
        "exec",
        "kopia",
        "kopia",
        "snapshot",
        "list",
        "--all",
        "--json-verbose",
        "--json",
    ]);
    const snapshots = JSON.parse(output || "[]") as unknown[];
    const byPath = new Map<string, ReturnType<typeof summarizeKopiaSnapshot>[]>();
    for (const snapshot of snapshots) {
        const summarized = summarizeKopiaSnapshot(snapshot);
        if (!summarized.path) {
            continue;
        }
        const grouped = byPath.get(summarized.path) ?? [];
        grouped.push(summarized);
        byPath.set(summarized.path, grouped);
    }

    const snapshotsByPath = [...byPath]
        .toSorted(([pathA], [pathB]) => pathA.localeCompare(pathB))
        .map(([pathName, groupedSnapshots]) => {
            const sortedSnapshots = groupedSnapshots.toSorted(
                (snapshotA, snapshotB) =>
                    getSnapshotTime(snapshotB) - getSnapshotTime(snapshotA)
            );
            const latestSnapshot = sortedSnapshots[0];
            return {
                path: pathName,
                latest: latestSnapshot,
                snapshots: sortedSnapshots,
                snapshotCount: sortedSnapshots.length,
            };
        });
    const latest = snapshotsByPath
        .map((group) => group.latest)
        .filter(
            (snapshot): snapshot is ReturnType<typeof summarizeKopiaSnapshot> =>
                snapshot !== undefined
        );
    const staleSnapshots = latest
        .filter((snapshot) => {
            if (!snapshot.endTime) {
                return true;
            }
            const endTimeMs = dateGetTime(new Date(snapshot.endTime));
            if (!Number.isFinite(endTimeMs)) {
                return true;
            }
            const ageHours = (Date.now() - endTimeMs) / 36e5;
            return ageHours > BACKUP_STATUS_STALE_HOURS;
        })
        .map((snapshot) => ({ path: snapshot.path, endTime: snapshot.endTime }));
    const missingSources = KOPIA_EXPECTED_SOURCE_PATHS.filter(
        (pathName) => !byPath.has(pathName)
    )
        .toSorted((pathA, pathB) => pathA.localeCompare(pathB))
        .map((pathName) => ({ path: pathName, endTime: undefined, missing: true }));
    const stale = [...staleSnapshots, ...missingSources];
    const payload = {
        checkedAt: nowIso(),
        tool: "kopia",
        latest,
        snapshotsByPath,
        stale,
        isOk: stale.length === 0 && latest.length >= KOPIA_EXPECTED_SOURCE_PATHS.length,
    };
    writeCacheSuccess({
        key: "backup.kopia.status",
        data: payload,
        source: "backend",
        ttl: payload.isOk
            ? backupStatusTtlHours(payload.latest.map((snapshot) => snapshot.endTime))
            : BACKUP_STATUS_MAX_TTL_HOURS,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Kopia Backup Status",
            summary: {
                isOk: payload.isOk,
                snapshotCount: payload.latest.length,
                staleCount: payload.stale.length,
                stalePaths: payload.stale.map((item) => item.path),
            },
        },
    });
    return { refreshed: ["backup.kopia.status"] };
}

function summarizeWalgBackup(value: unknown) {
    const backup = asRecord(value);
    const modified = firstValidTimestampValue(
        toOptionalString(backup.finish_time),
        toOptionalString(backup.start_time),
        toOptionalString(backup.time),
        toOptionalString(backup.modified)
    );
    const freshnessTime = firstValidTimestampValue(
        toOptionalString(backup.finish_time),
        toOptionalString(backup.start_time),
        toOptionalString(backup.time)
    );
    return {
        backupName: toOptionalString(backup.backup_name),
        modified,
        time: toOptionalString(backup.time),
        startTime: toOptionalString(backup.start_time),
        finishTime: toOptionalString(backup.finish_time),
        freshnessTime: freshnessTime ?? modified,
        walFileName: toOptionalString(backup.wal_file_name),
        storageName: toOptionalString(backup.storage_name),
    };
}

function getWalgBackupTime(backup: { freshnessTime: string | undefined }) {
    return firstValidTimestamp(backup.freshnessTime);
}

export async function refreshWalgBackupCache() {
    const output = await runCacheCommand(getDockerBin(), [
        "exec",
        "walg",
        "wal-g",
        "backup-list",
        "--detail",
        "--json",
    ]);
    const backups = (JSON.parse(output || "[]") as unknown[])
        .map((backup) => summarizeWalgBackup(backup))
        .toSorted(
            (backupA, backupB) => getWalgBackupTime(backupB) - getWalgBackupTime(backupA)
        );

    const latest = backups[0] ?? undefined;
    const latestFreshnessMs = latest?.freshnessTime
        ? dateGetTime(new Date(latest.freshnessTime))
        : Number.NaN;
    const latestAgeHours = Number.isFinite(latestFreshnessMs)
        ? (Date.now() - latestFreshnessMs) / 36e5
        : undefined;
    const isStale =
        !latest ||
        latestAgeHours === undefined ||
        latestAgeHours > BACKUP_STATUS_STALE_HOURS;
    const payload = {
        checkedAt: nowIso(),
        tool: "wal-g",
        latest,
        backups,
        backupCount: backups.length,
        latestAgeHours,
        stale: isStale,
        isOk: !isStale,
    };

    writeCacheSuccess({
        key: "backup.walg.status",
        data: payload,
        source: "backend",
        ttl: payload.isOk
            ? backupStatusTtlHours([payload.latest?.freshnessTime])
            : BACKUP_STATUS_MAX_TTL_HOURS,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - WAL-G Base Backup Status",
            summary: {
                isOk: payload.isOk,
                backupCount: payload.backupCount,
                latestBackupName: payload.latest?.backupName ?? undefined,
                stale: payload.stale,
                latestAgeHours: payload.latestAgeHours,
            },
        },
    });
    return { refreshed: ["backup.walg.status"] };
}
