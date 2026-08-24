import { getTime } from "date-fns";

import {
    deliveryOverviewSectionKeys,
    type DeliveryOverviewSectionId,
} from "../../../contracts/delivery.ts";
import { parseJsonText } from "../../../shared/json.ts";
import type { CacheRepository } from "../cache/repository.ts";

/** Exact domain-only cache row admitted by one Delivery section. */
export interface DeliveryOverviewSnapshotRecord {
    readonly expiresAtMs: number | null;
    readonly key: string;
    readonly lastAttemptAtMs: number;
    readonly lastAttemptStatus: "failed" | "succeeded";
    readonly lastSuccessAtMs: number | null;
    readonly payload: unknown;
    readonly schemaId: string | null;
    readonly source: string | null;
}

export interface DeliveryOverviewSnapshotRepository {
    readonly read: (
        section: DeliveryOverviewSectionId
    ) => DeliveryOverviewSnapshotRecord | undefined;
}

export type DeliveryOverviewCacheReader = Pick<CacheRepository, "findEntry">;

/**
 * Adapts only the four exact Delivery section keys from the claim-fenced cache.
 * @returns One domain-only Delivery snapshot repository.
 */
export function createDeliveryOverviewSnapshotRepository(
    cacheRepository: DeliveryOverviewCacheReader
): DeliveryOverviewSnapshotRepository {
    return Object.freeze({
        read(
            section: DeliveryOverviewSectionId
        ): DeliveryOverviewSnapshotRecord | undefined {
            const record = cacheRepository.findEntry(
                deliveryOverviewSectionKeys[section]
            );
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
