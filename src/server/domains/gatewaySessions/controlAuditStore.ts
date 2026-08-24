import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { DrizzleSecurityAuditStore } from "../security/securityAuditStore.ts";
import type { GatewaySessionControlAuditStore } from "./controlAudit.ts";

/**
 * Creates an admitted append-only audit store with no external work in SQLite.
 * @param database Process-owned typed SQLite handle.
 * @param writeAdmission Immediate-transaction admission boundary.
 * @returns Frozen append-only session-control audit store.
 */
export function createSqliteGatewaySessionControlAuditStore(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): GatewaySessionControlAuditStore {
    const store: GatewaySessionControlAuditStore = {
        append: (event) =>
            writeAdmission.run((markTransactionStarted) =>
                database.transaction(
                    (transaction) => {
                        markTransactionStarted();
                        new DrizzleSecurityAuditStore(transaction).insertAuditEvent(
                            event
                        );
                    },
                    { behavior: "immediate" }
                )
            ),
    };
    return Object.freeze(store);
}
