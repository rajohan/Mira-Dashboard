import * as v from "valibot";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { auditEventInsertSchema } from "../../database/validation/auditEvents.ts";
import type { SecurityAuditEvent } from "./audit.ts";
import type { SecurityPersistenceDatabase } from "./securityPersistenceTypes.ts";

export interface SecurityAuditWriter {
    insertAuditEvent(event: SecurityAuditEvent): void;
}

/** Focused validated persistence for append-only security audit events. */
export class DrizzleSecurityAuditStore implements SecurityAuditWriter {
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
}
