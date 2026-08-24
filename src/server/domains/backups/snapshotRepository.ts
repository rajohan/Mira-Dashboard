import { getTime } from "date-fns";

import { type BackupType, backupStatusCacheKeys } from "../../../contracts/backups.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { CacheRepository } from "../cache/repository.ts";

export interface BackupSnapshotRecord {
    readonly expiresAtMs: number | null;
    readonly key: string;
    readonly lastAttemptAtMs: number;
    readonly lastAttemptStatus: "failed" | "succeeded";
    readonly lastSuccessAtMs: number | null;
    readonly payload: unknown;
    readonly schemaId: string | null;
    readonly source: string | null;
}

export interface BackupSnapshotRepository {
    readonly read: (type: BackupType) => BackupSnapshotRecord | undefined;
}

/**
 * Restricts shared cache access to the exact two backup status entries.
 *
 * @param cache - Read-only access to shared cache records.
 * @returns The immutable backup snapshot repository.
 */
export function createBackupSnapshotRepository(
    cache: Pick<CacheRepository, "findEntry">
): BackupSnapshotRepository {
    const repository: BackupSnapshotRepository = {
        read(type) {
            const record = cache.findEntry(backupStatusCacheKeys[type]);
            if (record === undefined) return;
            let payload: unknown;
            if (record.payloadJson !== null) {
                try {
                    payload = parseJsonText(record.payloadJson);
                } catch {
                    // An invalid current payload remains unavailable to the domain.
                }
            }
            return Object.freeze({
                expiresAtMs: record.expiresAt === null ? null : getTime(record.expiresAt),
                key: record.key,
                lastAttemptAtMs: getTime(record.lastAttemptAt),
                lastAttemptStatus: record.lastAttemptStatus,
                lastSuccessAtMs:
                    record.lastSuccessAt === null ? null : getTime(record.lastSuccessAt),
                payload,
                schemaId: record.schemaId,
                source: record.source,
            });
        },
    };
    return Object.freeze(repository);
}
