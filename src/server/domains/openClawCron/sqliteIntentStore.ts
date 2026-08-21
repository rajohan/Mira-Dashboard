import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { jobDisableIntents } from "../../database/schema/jobDisableIntents.ts";
import {
    jobDisableIntentCloseSchema,
    jobDisableIntentInsertSchema,
    jobDisableIntentSelectSchema,
} from "../../database/validation/jobDisableIntents.ts";
import type {
    CloseOpenClawCronDisableIntentInput,
    OpenClawCronActiveDisableIntent,
    OpenClawCronExpiredDisableIntentTarget,
    OpenClawCronIntentStore,
    ReplaceOpenClawCronDisableIntentInput,
} from "./intentStore.ts";
import { openClawCronExpiredIntentBatchMaximum } from "./intentStore.ts";

type IntentRow = v.InferOutput<typeof jobDisableIntentSelectSchema>;

function activeIntent(row: IntentRow): OpenClawCronActiveDisableIntent {
    if (
        row.targetKind !== "openclaw-cron" ||
        row.externalProvider !== "openclaw" ||
        row.externalJobId === null
    ) {
        throw new TypeError("Stored OpenClaw cron intent target is inconsistent");
    }
    return Object.freeze({
        createdBy: Object.freeze({
            id: row.createdById,
            kind: row.createdByKind,
        }),
        ...(row.expiresAt === null ? {} : { expiresAtMs: row.expiresAt.getTime() }),
        externalJobId: row.externalJobId,
        reason: row.reason,
        recordedAtMs: row.createdAt.getTime(),
        revision: row.id,
    });
}

function parseActiveRow(row: unknown): OpenClawCronActiveDisableIntent {
    const parsed = v.parse(jobDisableIntentSelectSchema, row);
    if (parsed.endedAt !== null) {
        throw new TypeError("Stored OpenClaw cron intent is already closed");
    }
    return activeIntent(parsed);
}

function activeTargetWhere(externalJobId: string) {
    return and(
        eq(jobDisableIntents.targetKind, "openclaw-cron"),
        eq(jobDisableIntents.externalProvider, "openclaw"),
        eq(jobDisableIntents.externalJobId, externalJobId),
        isNull(jobDisableIntents.endedAt)
    );
}

/**
 * Creates the admitted append-only OpenClaw cron intent store over the shared table.
 * Replacements and closures are guarded in one IMMEDIATE transaction.
 * @param database Process-owned typed SQLite handle.
 * @param writeAdmission Immediate-transaction admission boundary.
 * @param generateId Persisted UUIDv7 generator.
 * @returns An append-only, bounded OpenClaw cron intent store.
 */
export function createSqliteOpenClawCronIntentStore(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission,
    generateId: () => string = () => Bun.randomUUIDv7()
): OpenClawCronIntentStore {
    function getActive(
        externalJobId: string
    ): Promise<OpenClawCronActiveDisableIntent | undefined> {
        const row = database
            .select()
            .from(jobDisableIntents)
            .where(activeTargetWhere(externalJobId))
            .get();
        return Promise.resolve(row === undefined ? undefined : parseActiveRow(row));
    }

    function closeActive(input: CloseOpenClawCronDisableIntentInput): Promise<boolean> {
        return writeAdmission.run((markTransactionStarted) =>
            database.transaction(
                (transaction) => {
                    markTransactionStarted();
                    const conditions = [activeTargetWhere(input.externalJobId)];
                    if ("expectedRevision" in input) {
                        conditions.push(eq(jobDisableIntents.id, input.expectedRevision));
                    }
                    if (input.reason === "expired") {
                        conditions.push(
                            lte(jobDisableIntents.expiresAt, new Date(input.atMs))
                        );
                    }
                    const current = transaction
                        .select()
                        .from(jobDisableIntents)
                        .where(and(...conditions))
                        .get();
                    if (current === undefined) return false;
                    const parsed = v.parse(jobDisableIntentSelectSchema, current);
                    const endedAt = new Date(
                        Math.max(input.atMs, parsed.createdAt.getTime())
                    );
                    const closure = v.parse(jobDisableIntentCloseSchema, {
                        endedAt,
                        endedById: input.actor.id,
                        endedByKind: input.actor.kind,
                        endedReason: input.reason,
                    });
                    return (
                        transaction
                            .update(jobDisableIntents)
                            .set(closure)
                            .where(
                                and(
                                    eq(jobDisableIntents.id, parsed.id),
                                    isNull(jobDisableIntents.endedAt)
                                )
                            )
                            .run().changes === 1
                    );
                },
                { behavior: "immediate" }
            )
        );
    }

    function listExpired(
        atMs: number,
        limit: number
    ): Promise<readonly OpenClawCronExpiredDisableIntentTarget[]> {
        if (
            !Number.isSafeInteger(atMs) ||
            atMs < 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1 ||
            limit > openClawCronExpiredIntentBatchMaximum
        ) {
            return Promise.reject(
                new RangeError("OpenClaw cron expiry scan is outside its budget")
            );
        }
        const rows = database
            .select()
            .from(jobDisableIntents)
            .where(
                and(
                    eq(jobDisableIntents.targetKind, "openclaw-cron"),
                    eq(jobDisableIntents.externalProvider, "openclaw"),
                    isNull(jobDisableIntents.endedAt),
                    lte(jobDisableIntents.expiresAt, new Date(atMs))
                )
            )
            .orderBy(asc(jobDisableIntents.expiresAt), asc(jobDisableIntents.id))
            .limit(limit)
            .all();
        return Promise.resolve(
            rows.map((row) => {
                const intent = parseActiveRow(row);
                if (intent.expiresAtMs === undefined) {
                    throw new TypeError(
                        "Stored expired OpenClaw cron intent has no expiry"
                    );
                }
                return Object.freeze({
                    expiresAtMs: intent.expiresAtMs,
                    externalJobId: intent.externalJobId,
                    revision: intent.revision,
                });
            })
        );
    }

    function replaceActive(
        input: ReplaceOpenClawCronDisableIntentInput
    ): Promise<OpenClawCronActiveDisableIntent> {
        return writeAdmission.run((markTransactionStarted) =>
            database.transaction(
                (transaction) => {
                    markTransactionStarted();
                    const current = transaction
                        .select()
                        .from(jobDisableIntents)
                        .where(activeTargetWhere(input.externalJobId))
                        .get();
                    if (current !== undefined) {
                        const parsedCurrent = v.parse(
                            jobDisableIntentSelectSchema,
                            current
                        );
                        transaction
                            .update(jobDisableIntents)
                            .set(
                                v.parse(jobDisableIntentCloseSchema, {
                                    endedAt: new Date(
                                        Math.max(
                                            input.recordedAtMs,
                                            parsedCurrent.createdAt.getTime()
                                        )
                                    ),
                                    endedById: input.actor.id,
                                    endedByKind: input.actor.kind,
                                    endedReason: "replaced",
                                })
                            )
                            .where(
                                and(
                                    eq(jobDisableIntents.id, parsedCurrent.id),
                                    isNull(jobDisableIntents.endedAt)
                                )
                            )
                            .run();
                    }
                    const row = v.parse(jobDisableIntentInsertSchema, {
                        createdAt: new Date(input.recordedAtMs),
                        createdById: input.actor.id,
                        createdByKind: input.actor.kind,
                        endedAt: null,
                        endedById: null,
                        endedByKind: null,
                        endedReason: null,
                        expiresAt:
                            input.expiresAtMs === undefined
                                ? null
                                : new Date(input.expiresAtMs),
                        externalJobId: input.externalJobId,
                        externalProvider: "openclaw",
                        id: generateId(),
                        reason: input.reason,
                        scheduledJobId: null,
                        targetKind: "openclaw-cron",
                    });
                    const inserted = transaction
                        .insert(jobDisableIntents)
                        .values(row)
                        .returning()
                        .get();
                    if (inserted === undefined) {
                        throw new Error("OpenClaw cron intent insert returned no row");
                    }
                    return parseActiveRow(inserted);
                },
                { behavior: "immediate" }
            )
        );
    }

    return Object.freeze({ closeActive, getActive, listExpired, replaceActive });
}
