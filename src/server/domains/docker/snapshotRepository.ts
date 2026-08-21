import { getTime } from "date-fns";

import { dockerOverviewCacheKey } from "../../../contracts/docker.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { CacheRepository } from "../cache/repository.ts";

/** Exact domain-only cache row admitted by Docker observability. */
export interface DockerOverviewSnapshotRecord {
    readonly expiresAtMs: number | null;
    readonly key: string;
    readonly lastAttemptAtMs: number;
    readonly lastAttemptStatus: "failed" | "succeeded";
    readonly lastSuccessAtMs: number | null;
    readonly payload: unknown;
    readonly schemaId: string | null;
    readonly source: string | null;
}

/** Narrow cache reader that cannot enumerate unrelated provider state. */
export interface DockerOverviewSnapshotRepository {
    readonly read: () => DockerOverviewSnapshotRecord | undefined;
}

export type DockerOverviewCacheReader = Pick<CacheRepository, "findEntry">;

/**
 * Adapts only `docker.overview` from the shared claim-fenced cache. Invalid JSON is
 * deliberately forwarded as missing untrusted payload for the domain validator.
 * @param cacheRepository Shared cache reader restricted by this adapter.
 * @returns One domain-only Docker snapshot repository.
 */
export function createDockerOverviewSnapshotRepository(
    cacheRepository: DockerOverviewCacheReader
): DockerOverviewSnapshotRepository {
    return Object.freeze({
        read(): DockerOverviewSnapshotRecord | undefined {
            const record = cacheRepository.findEntry(dockerOverviewCacheKey);
            if (record === undefined) return undefined;
            let payload: unknown;
            if (record.payloadJson !== null) {
                try {
                    payload = parseJsonText(record.payloadJson);
                } catch {
                    payload = undefined;
                }
            }
            return {
                expiresAtMs: record.expiresAt === null ? null : getTime(record.expiresAt),
                key: record.key,
                lastAttemptAtMs: getTime(record.lastAttemptAt),
                lastAttemptStatus: record.lastAttemptStatus,
                lastSuccessAtMs:
                    record.lastSuccessAt === null ? null : getTime(record.lastSuccessAt),
                payload,
                schemaId: record.schemaId,
                source: record.source,
            };
        },
    });
}
