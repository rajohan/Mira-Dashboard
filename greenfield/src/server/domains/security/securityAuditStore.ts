import { and, desc, eq, gt, lt, or } from "drizzle-orm";
import * as v from "valibot";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import {
    auditEventInsertSchema,
    auditEventSelectSchema,
} from "../../database/validation/auditEvents.ts";
import type { SecurityAuditEvent } from "./audit.ts";
import type { SecurityPersistenceDatabase } from "./securityPersistenceTypes.ts";

export type SecurityAuditEventRecord = v.InferOutput<typeof auditEventSelectSchema>;

export interface SecurityAuditEventListInput {
    readonly beforeId?: string;
    readonly beforeOccurredAt?: Date;
    readonly limit: number;
}

function assertSecurityAuditListInput(input: SecurityAuditEventListInput): void {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 256) {
        throw new RangeError("Security audit event list limit is invalid");
    }
    if ((input.beforeId === undefined) !== (input.beforeOccurredAt === undefined)) {
        throw new TypeError("Security audit event cursor is incomplete");
    }
}

function parseSecurityAuditEvent(row: unknown): SecurityAuditEventRecord {
    return v.parse(auditEventSelectSchema, row);
}

export interface SecurityAuditReader {
    hasFutureEvents(checkedAt: Date): boolean;
    listEvents(input: SecurityAuditEventListInput): SecurityAuditEventRecord[];
}

export interface SecurityAuditWriter {
    insertAuditEvent(event: SecurityAuditEvent): void;
}

/** Focused validated persistence for append-only security audit events. */
export class DrizzleSecurityAuditStore
    implements SecurityAuditReader, SecurityAuditWriter
{
    readonly #database: SecurityPersistenceDatabase;

    constructor(database: SecurityPersistenceDatabase) {
        this.#database = database;
    }

    insertAuditEvent(event: SecurityAuditEvent): void {
        this.#database
            .insert(auditEvents)
            .values(v.parse(auditEventInsertSchema, event))
            .run();
    }

    hasFutureEvents(checkedAt: Date): boolean {
        return (
            this.#database
                .select({ id: auditEvents.id })
                .from(auditEvents)
                .where(gt(auditEvents.occurredAt, checkedAt))
                .limit(1)
                .get() !== undefined
        );
    }

    listEvents(input: SecurityAuditEventListInput): SecurityAuditEventRecord[] {
        assertSecurityAuditListInput(input);
        const boundary =
            input.beforeId === undefined || input.beforeOccurredAt === undefined
                ? undefined
                : or(
                      lt(auditEvents.occurredAt, input.beforeOccurredAt),
                      and(
                          eq(auditEvents.occurredAt, input.beforeOccurredAt),
                          lt(auditEvents.id, input.beforeId)
                      )
                  );
        return this.#database
            .select()
            .from(auditEvents)
            .where(boundary)
            .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
            .limit(input.limit)
            .all()
            .map((row) => parseSecurityAuditEvent(row));
    }
}
