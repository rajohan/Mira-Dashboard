import { addMilliseconds, getTime, toDate } from "date-fns";
import { and, asc, count, eq, gt } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    cacheEntryKeySchema,
    cacheEntryMetadataSchema,
    cacheEntrySchemaIdSchema,
    cacheEntrySourceSchema,
    cacheFailureCodeSchema,
    cacheFailureMessageSchema,
    cacheLastAttemptDurationSchema,
    cacheStatusMaximumEntries,
} from "../../../contracts/cache.ts";
import {
    cacheChangePayloadSchema,
    cacheRealtimeRoutingSchema,
    cacheRealtimeTopic,
} from "../../../contracts/cacheRealtime.ts";
import { jobTimestampSchema } from "../../../contracts/jobModel.ts";
import { realtimeEventRetentionMilliseconds } from "../../../contracts/realtime.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { cacheEntries } from "../../database/schema/cacheEntries.ts";
import { jobRuns } from "../../database/schema/jobRuns.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import {
    cacheEntryInsertSchema,
    cacheEntrySelectSchema,
} from "../../database/validation/cacheEntries.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import type {
    JobCacheAttemptCommit,
    JobCacheAttemptWriteResult,
} from "../jobs/actionRegistry.ts";
import { findJobActionDefinition } from "../jobs/actionRegistry.ts";
import {
    findCacheProviderDefinition,
    parseCacheProviderPayload,
} from "./providerRegistry.ts";

export type CacheEntryRecord = v.InferOutput<typeof cacheEntrySelectSchema>;

export interface CacheStatusSnapshot {
    readonly entries: readonly CacheEntryRecord[];
    readonly totalCount: number;
}

export interface CacheAttemptCommitInput {
    readonly at: Date;
    readonly attempt: number;
    readonly leaseToken: string;
    readonly outcome: JobCacheAttemptCommit;
    readonly runId: string;
    readonly workerId: string;
}

export interface CacheRepository {
    commitAttempt(input: CacheAttemptCommitInput): Promise<JobCacheAttemptWriteResult>;
    findEntry(key: string): CacheEntryRecord | undefined;
    readStatus(limit?: number): CacheStatusSnapshot;
}

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type CacheTransaction = Parameters<TransactionCallback>[0];

function parseRecord(row: unknown): CacheEntryRecord {
    return v.parse(cacheEntrySelectSchema, row);
}

function requiredCount(row: { value: number } | undefined): number {
    if (row === undefined || !Number.isSafeInteger(row.value) || row.value < 0) {
        throw new Error("Cache repository count returned an invalid value");
    }
    return row.value;
}

function attemptKeys(outcome: JobCacheAttemptCommit): readonly string[] {
    return outcome.kind === "failed"
        ? [outcome.key]
        : outcome.entries.map((entry) => entry.key);
}

interface CacheAttemptAuthority {
    readonly actionKey: string;
    readonly payloadJson: string;
}

function cacheAttemptAuthority(keys: readonly string[]): CacheAttemptAuthority {
    const authorities = keys.map((key) => {
        const provider = findCacheProviderDefinition(key);
        const action =
            provider === undefined
                ? undefined
                : findJobActionDefinition(provider.actionKey);
        if (provider === undefined || action === undefined) {
            throw new Error("Cache provider action authority is unavailable");
        }
        return {
            actionKey: action.actionKey,
            payloadJson: JSON.stringify(action.actionPayload),
        };
    });
    const authority = authorities[0];
    if (
        authority === undefined ||
        authorities.some(
            (candidate) =>
                candidate.actionKey !== authority.actionKey ||
                candidate.payloadJson !== authority.payloadJson
        )
    ) {
        throw new Error("Cache provider group spans multiple action authorities");
    }
    return authority;
}

function validateAttemptOutcome(outcome: JobCacheAttemptCommit): JobCacheAttemptCommit {
    v.parse(cacheLastAttemptDurationSchema, outcome.durationMs);
    if (outcome.kind === "failed") {
        v.parse(cacheEntryKeySchema, outcome.key);
        v.parse(cacheFailureCodeSchema, outcome.failureCode);
        v.parse(cacheFailureMessageSchema, outcome.failureMessage);
        if (findCacheProviderDefinition(outcome.key) === undefined) {
            throw new Error("Cache failure names an unregistered provider");
        }
        return outcome;
    }
    if (outcome.entries.length === 0 || outcome.entries.length > 32) {
        throw new RangeError("Cache provider entry group is outside its budget");
    }
    const keys = new Set<string>();
    for (const entry of outcome.entries) {
        v.parse(cacheEntryKeySchema, entry.key);
        v.parse(cacheEntryMetadataSchema, entry.metadata);
        v.parse(cacheEntrySchemaIdSchema, entry.schemaId);
        v.parse(cacheEntrySourceSchema, entry.source);
        const provider = findCacheProviderDefinition(entry.key);
        if (
            provider === undefined ||
            provider.schemaId !== entry.schemaId ||
            provider.source !== entry.source ||
            provider.ttlMs !== entry.ttlMs
        ) {
            throw new Error("Cache success does not match its provider definition");
        }
        parseCacheProviderPayload(provider, entry.payload);
        if (keys.has(entry.key)) {
            throw new Error("Cache provider entry group contains duplicate keys");
        }
        keys.add(entry.key);
    }
    return outcome;
}

function existingEntry(
    transaction: CacheTransaction,
    key: string
): CacheEntryRecord | undefined {
    const row = transaction
        .select()
        .from(cacheEntries)
        .where(eq(cacheEntries.key, key))
        .get();
    return row === undefined ? undefined : parseRecord(row);
}

function appendRealtimeEvent(
    transaction: CacheTransaction,
    input: {
        readonly at: Date;
        readonly key: string;
        readonly operation: "created" | "updated";
    }
): void {
    v.parse(cacheRealtimeRoutingSchema, {
        entityType: "cache-entry",
        operation: input.operation,
        topic: cacheRealtimeTopic,
    });
    const payload = v.parse(cacheChangePayloadSchema, { key: input.key });
    transaction
        .insert(realtimeEvents)
        .values(
            v.parse(realtimeEventInsertSchema, {
                entityId: input.key,
                entityType: "cache-entry",
                expiresAt: addMilliseconds(input.at, realtimeEventRetentionMilliseconds),
                occurredAt: input.at,
                operation: input.operation,
                payloadJson: JSON.stringify(payload),
                topic: cacheRealtimeTopic,
            })
        )
        .run();
}

function upsertAttempt(
    transaction: CacheTransaction,
    input: CacheAttemptCommitInput,
    at: Date,
    key: string,
    existing: CacheEntryRecord | undefined
): CacheEntryRecord {
    const outcome = input.outcome;
    const succeededEntry =
        outcome.kind === "succeeded"
            ? outcome.entries.find((entry) => entry.key === key)
            : undefined;
    const row = v.parse(cacheEntryInsertSchema, {
        consecutiveFailures:
            outcome.kind === "failed" ? (existing?.consecutiveFailures ?? 0) + 1 : 0,
        expiresAt:
            succeededEntry === undefined
                ? (existing?.expiresAt ?? null)
                : addMilliseconds(at, succeededEntry.ttlMs),
        failureCode: outcome.kind === "failed" ? outcome.failureCode : null,
        failureMessage: outcome.kind === "failed" ? outcome.failureMessage : null,
        key,
        lastAttemptAt: at,
        lastAttemptDurationMs: outcome.durationMs,
        lastAttemptNumber: input.attempt,
        lastAttemptRunId: input.runId,
        lastAttemptStatus: outcome.kind === "failed" ? "failed" : "succeeded",
        lastSuccessAt:
            succeededEntry === undefined ? (existing?.lastSuccessAt ?? null) : at,
        metadataJson:
            succeededEntry === undefined
                ? (existing?.metadataJson ?? null)
                : JSON.stringify(succeededEntry.metadata),
        payloadJson:
            succeededEntry === undefined
                ? (existing?.payloadJson ?? null)
                : JSON.stringify(succeededEntry.payload),
        schemaId:
            succeededEntry === undefined
                ? (existing?.schemaId ?? null)
                : succeededEntry.schemaId,
        source:
            succeededEntry === undefined
                ? (existing?.source ?? null)
                : succeededEntry.source,
        updatedAt: at,
    });
    const stored = transaction
        .insert(cacheEntries)
        .values(row)
        .onConflictDoUpdate({
            set: row,
            target: cacheEntries.key,
        })
        .returning()
        .get();
    if (stored === undefined) throw new Error("Cache attempt returned no row");
    return parseRecord(stored);
}

/**
 * Creates the SQLite-backed cache repository and its claim-fenced write port.
 * @param database Shared application database.
 * @param writeAdmission Immediate-transaction admission boundary.
 * @param nowMs Fresh transaction-admission clock used only for claim authority.
 * @returns A cache repository backed by the supplied database.
 */
export function createCacheRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission,
    nowMs: () => number = Date.now
): CacheRepository {
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: CacheTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const withReadTransaction = <T>(callback: (transaction: CacheTransaction) => T): T =>
        runTransaction(callback, { behavior: "deferred" });

    return Object.freeze({
        async commitAttempt(input: CacheAttemptCommitInput) {
            const outcome = validateAttemptOutcome(input.outcome);
            const keys = attemptKeys(outcome);
            const authority = cacheAttemptAuthority(keys);
            const result = await writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction): JobCacheAttemptWriteResult => {
                        markTransactionStarted();
                        const admittedAtMs = v.parse(jobTimestampSchema, nowMs());
                        const existingByKey = new Map(
                            keys.map((key) => [key, existingEntry(transaction, key)])
                        );
                        const candidateAt = Math.max(
                            getTime(input.at),
                            ...[...existingByKey.values()].flatMap((entry) =>
                                entry === undefined ? [] : [getTime(entry.updatedAt)]
                            )
                        );
                        const rawRun = transaction
                            .select({
                                actionKey: jobRuns.actionKey,
                                payloadJson: jobRuns.payloadJson,
                                updatedAt: jobRuns.updatedAt,
                            })
                            .from(jobRuns)
                            .where(eq(jobRuns.id, input.runId))
                            .get();
                        if (
                            rawRun === undefined ||
                            rawRun.actionKey !== authority.actionKey ||
                            rawRun.payloadJson !== authority.payloadJson
                        ) {
                            return "lost-claim";
                        }
                        const at = toDate(
                            Math.max(candidateAt, getTime(rawRun.updatedAt))
                        );
                        const authorityAt = toDate(
                            Math.max(
                                admittedAtMs,
                                getTime(input.at),
                                getTime(rawRun.updatedAt)
                            )
                        );
                        const fenced = transaction
                            .select({ id: jobRuns.id })
                            .from(jobRuns)
                            .where(
                                and(
                                    eq(jobRuns.id, input.runId),
                                    eq(jobRuns.state, "running"),
                                    eq(jobRuns.attemptCount, input.attempt),
                                    eq(jobRuns.actionKey, authority.actionKey),
                                    eq(jobRuns.payloadJson, authority.payloadJson),
                                    eq(jobRuns.leaseOwnerId, input.workerId),
                                    eq(jobRuns.leaseToken, input.leaseToken),
                                    gt(jobRuns.leaseExpiresAt, authorityAt)
                                )
                            )
                            .get();
                        if (fenced === undefined) return "lost-claim";
                        for (const key of keys) {
                            const record = upsertAttempt(
                                transaction,
                                { ...input, outcome },
                                at,
                                key,
                                existingByKey.get(key)
                            );
                            appendRealtimeEvent(transaction, {
                                at: record.updatedAt,
                                key,
                                operation:
                                    existingByKey.get(key) === undefined
                                        ? "created"
                                        : "updated",
                            });
                        }
                        return "committed";
                    },
                    { behavior: "immediate" }
                )
            );
            return result;
        },
        findEntry(key: string) {
            v.parse(cacheEntryKeySchema, key);
            return withReadTransaction((transaction) => existingEntry(transaction, key));
        },
        readStatus(limit: number = cacheStatusMaximumEntries) {
            if (
                !Number.isSafeInteger(limit) ||
                limit < 1 ||
                limit > cacheStatusMaximumEntries
            ) {
                throw new RangeError("Cache status limit is invalid");
            }
            return withReadTransaction((transaction) => ({
                entries: Object.freeze(
                    transaction
                        .select()
                        .from(cacheEntries)
                        .orderBy(asc(cacheEntries.key))
                        .limit(limit)
                        .all()
                        .map((row) => parseRecord(row))
                ),
                totalCount: requiredCount(
                    transaction.select({ value: count() }).from(cacheEntries).get()
                ),
            }));
        },
    });
}
