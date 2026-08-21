import { getTime } from "date-fns";

import { databaseObservabilityCacheKey } from "../../../contracts/database.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { CacheRepository } from "../cache/repository.ts";
import type {
    DatabaseObservabilitySnapshotRecord,
    DatabaseObservabilitySnapshotRepository,
} from "./service.ts";

/** Minimal shared-cache read authority needed by the database domain adapter. */
export type DatabaseObservabilityCacheReader = Pick<CacheRepository, "findEntry">;

/**
 * Adapts the one exact cache key to the database domain without exposing generic cache reads.
 * Payload parsing remains untrusted; the database service validates the strict domain schema.
 * @param cacheRepository Shared claim-fenced cache repository.
 * @returns Domain-only external database snapshot reader.
 */
export function createDatabaseObservabilitySnapshotRepository(
    cacheRepository: DatabaseObservabilityCacheReader
): DatabaseObservabilitySnapshotRepository {
    return Object.freeze({
        read(): DatabaseObservabilitySnapshotRecord | undefined {
            const record = cacheRepository.findEntry(databaseObservabilityCacheKey);
            if (record === undefined) return undefined;
            return {
                expiresAtMs: record.expiresAt === null ? null : getTime(record.expiresAt),
                key: record.key,
                lastAttemptAtMs: getTime(record.lastAttemptAt),
                lastAttemptStatus: record.lastAttemptStatus,
                lastSuccessAtMs:
                    record.lastSuccessAt === null ? null : getTime(record.lastSuccessAt),
                payload:
                    record.payloadJson === null
                        ? undefined
                        : parseJsonText(record.payloadJson),
                schemaId: record.schemaId,
                source: record.source,
            };
        },
    });
}
