import { toDate } from "date-fns";
import { and, desc, eq, inArray, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    agentTaskHistoryPageMaximum,
    type ListAgentTaskHistoryInput,
} from "../../../contracts/agents.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { agentTaskRuns } from "../../database/schema/agentTaskRuns.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import {
    agentTaskRunInsertSchema,
    agentTaskRunSelectSchema,
    agentTaskRunUpdateSchema,
} from "../../database/validation/agentTaskRuns.ts";
import {
    realtimeEventInsertSchema,
    realtimeEventSelectSchema,
} from "../../database/validation/realtimeEvents.ts";

export type AgentTaskRunRecord = v.InferOutput<typeof agentTaskRunSelectSchema>;
export type AgentTaskRunInsert = v.InferOutput<typeof agentTaskRunInsertSchema>;
export type AgentRealtimeEventInsert = v.InferOutput<typeof realtimeEventInsertSchema>;

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type AgentTransaction = Parameters<TransactionCallback>[0];
type AgentPersistenceDatabase = AgentTransaction | SQLiteBunDatabase;
type SynchronousResult<T> = T extends Promise<unknown> ? never : T;

export interface AgentRunActor {
    readonly id: string;
    readonly kind: "automation" | "user";
}

export interface AgentRepositoryReader {
    findActiveRun(agentId: string): AgentTaskRunRecord | undefined;
    findLatestRun(agentId: string): AgentTaskRunRecord | undefined;
    listActiveRuns(agentIds: readonly string[]): AgentTaskRunRecord[];
    listTaskRuns(input: ListAgentTaskHistoryInput): AgentTaskRunRecord[];
}

export interface AgentRepositoryUnitOfWork extends AgentRepositoryReader {
    completeRun(
        id: string,
        completedAt: Date,
        actor: AgentRunActor
    ): AgentTaskRunRecord | undefined;
    insertRealtimeEvent(input: AgentRealtimeEventInsert): number;
    insertRun(input: AgentTaskRunInsert): AgentTaskRunRecord | undefined;
    touchRun(
        id: string,
        lastActivityAt: Date,
        actor: AgentRunActor
    ): AgentTaskRunRecord | undefined;
}

export interface AgentRepository extends AgentRepositoryReader {
    withImmediateTransaction<T>(
        callback: (unit: AgentRepositoryUnitOfWork) => SynchronousResult<T>
    ): Promise<T>;
    withReadTransaction<T>(
        callback: (reader: AgentRepositoryReader) => SynchronousResult<T>
    ): T;
}

function parseRun(row: unknown): AgentTaskRunRecord {
    return v.parse(agentTaskRunSelectSchema, row);
}

function requiredRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined)
        throw new Error(`Agent repository ${operation} returned no row`);
    return row;
}

function assertPageLimit(limit: number): void {
    if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > agentTaskHistoryPageMaximum
    ) {
        throw new RangeError("Agent task history page limit is invalid");
    }
}

function historyCursorBoundary(input: ListAgentTaskHistoryInput): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const startedAt = toDate(input.cursor.startedAtMs);
    return or(
        lt(agentTaskRuns.startedAt, startedAt),
        and(eq(agentTaskRuns.startedAt, startedAt), lt(agentTaskRuns.id, input.cursor.id))
    );
}

class DrizzleAgentRepositoryReader implements AgentRepositoryReader {
    protected readonly database: AgentPersistenceDatabase;

    public constructor(database: AgentPersistenceDatabase) {
        this.database = database;
    }

    public findActiveRun(agentId: string): AgentTaskRunRecord | undefined {
        const row = this.database
            .select()
            .from(agentTaskRuns)
            .where(
                and(eq(agentTaskRuns.agentId, agentId), isNull(agentTaskRuns.completedAt))
            )
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public findLatestRun(agentId: string): AgentTaskRunRecord | undefined {
        const row = this.database
            .select()
            .from(agentTaskRuns)
            .where(eq(agentTaskRuns.agentId, agentId))
            .orderBy(desc(agentTaskRuns.startedAt), desc(agentTaskRuns.id))
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public listActiveRuns(agentIds: readonly string[]): AgentTaskRunRecord[] {
        if (agentIds.length === 0) return [];
        return this.database
            .select()
            .from(agentTaskRuns)
            .where(
                and(
                    inArray(agentTaskRuns.agentId, [...agentIds]),
                    isNull(agentTaskRuns.completedAt)
                )
            )
            .orderBy(desc(agentTaskRuns.agentId))
            .limit(agentIds.length + 1)
            .all()
            .map((row) => parseRun(row));
    }

    public listTaskRuns(input: ListAgentTaskHistoryInput): AgentTaskRunRecord[] {
        assertPageLimit(input.limit);
        return this.database
            .select()
            .from(agentTaskRuns)
            .where(
                and(
                    input.agentId === undefined
                        ? undefined
                        : eq(agentTaskRuns.agentId, input.agentId),
                    historyCursorBoundary(input)
                )
            )
            .orderBy(desc(agentTaskRuns.startedAt), desc(agentTaskRuns.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseRun(row));
    }
}

class DrizzleAgentRepositoryUnitOfWork
    extends DrizzleAgentRepositoryReader
    implements AgentRepositoryUnitOfWork
{
    readonly #transaction: AgentTransaction;

    public constructor(transaction: AgentTransaction) {
        super(transaction);
        this.#transaction = transaction;
    }

    public completeRun(
        id: string,
        completedAt: Date,
        actor: AgentRunActor
    ): AgentTaskRunRecord | undefined {
        const changes = v.parse(agentTaskRunUpdateSchema, {
            completedAt,
            completedById: actor.id,
            completedByKind: actor.kind,
            lastActivityAt: completedAt,
            lastUpdatedById: actor.id,
            lastUpdatedByKind: actor.kind,
        });
        const row = this.#transaction
            .update(agentTaskRuns)
            .set(changes)
            .where(
                and(
                    eq(agentTaskRuns.id, id),
                    isNull(agentTaskRuns.completedAt),
                    lte(agentTaskRuns.lastActivityAt, completedAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public insertRealtimeEvent(input: AgentRealtimeEventInsert): number {
        const row = this.#transaction
            .insert(realtimeEvents)
            .values(v.parse(realtimeEventInsertSchema, input))
            .returning()
            .get();
        return v.parse(
            realtimeEventSelectSchema,
            requiredRow(row, "realtime event insert")
        ).id;
    }

    public insertRun(input: AgentTaskRunInsert): AgentTaskRunRecord | undefined {
        const row = this.#transaction
            .insert(agentTaskRuns)
            .values(v.parse(agentTaskRunInsertSchema, input))
            .onConflictDoNothing()
            .returning()
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public touchRun(
        id: string,
        lastActivityAt: Date,
        actor: AgentRunActor
    ): AgentTaskRunRecord | undefined {
        const changes = v.parse(agentTaskRunUpdateSchema, {
            completedAt: null,
            completedById: null,
            completedByKind: null,
            lastActivityAt,
            lastUpdatedById: actor.id,
            lastUpdatedByKind: actor.kind,
        });
        const row = this.#transaction
            .update(agentTaskRuns)
            .set(changes)
            .where(
                and(
                    eq(agentTaskRuns.id, id),
                    isNull(agentTaskRuns.completedAt),
                    lte(agentTaskRuns.lastActivityAt, lastActivityAt)
                )
            )
            .returning()
            .get();
        return row === undefined ? undefined : parseRun(row);
    }
}

/**
 * Creates validated reads and runtime-admitted agent current-task writes.
 * @param database Process-owned Drizzle SQLite database.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns Agent repository with snapshot reads and admitted writes.
 */
export function createAgentRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): AgentRepository {
    // Drizzle's generic SQLite signature retains its async-driver conditional even
    // though Bun's concrete session is synchronous. Adapt it once at this boundary
    // while keeping repository callbacks statically unable to return a Promise.
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: AgentTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const withReadTransaction = <T>(
        callback: (reader: AgentRepositoryReader) => SynchronousResult<T>
    ): T =>
        runTransaction(
            (transaction: AgentTransaction) =>
                callback(new DrizzleAgentRepositoryReader(transaction)),
            { behavior: "deferred" }
        );

    return Object.freeze({
        findActiveRun: (agentId: string) =>
            withReadTransaction((reader) => reader.findActiveRun(agentId)),
        findLatestRun: (agentId: string) =>
            withReadTransaction((reader) => reader.findLatestRun(agentId)),
        listActiveRuns: (agentIds: readonly string[]) =>
            withReadTransaction((reader) => reader.listActiveRuns(agentIds)),
        listTaskRuns: (input: ListAgentTaskHistoryInput) =>
            withReadTransaction((reader) => reader.listTaskRuns(input)),
        withImmediateTransaction<T>(
            callback: (unit: AgentRepositoryUnitOfWork) => SynchronousResult<T>
        ): Promise<T> {
            return writeAdmission.run((markTransactionStarted) =>
                runTransaction(
                    (transaction: AgentTransaction) => {
                        markTransactionStarted();
                        return callback(
                            new DrizzleAgentRepositoryUnitOfWork(transaction)
                        );
                    },
                    { behavior: "immediate" }
                )
            );
        },
        withReadTransaction,
    });
}
