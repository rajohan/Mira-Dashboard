import { expect, test } from "bun:test";

import { auditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { createSecurityAuditEvent } from "../security/audit.ts";
import { createSqliteGatewaySessionControlAuditStore } from "./controlAuditStore.ts";

test("appends one validated session-control audit row in an admitted transaction", async () => {
    const database = await openFreshMigratedDatabase();
    const store = createSqliteGatewaySessionControlAuditStore(
        database.orm,
        testImmediateDatabaseWriteAdmission
    );
    const event = createSecurityAuditEvent({
        action: "gateway.sessions.reset",
        actor: {
            authenticatorId: "a".repeat(32),
            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
            kind: "user",
        },
        id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b6",
        occurredAt: new Date(1_800_000_000_000),
        outcome: "attempted",
        requestId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
        targetId: `sha256:${"a".repeat(64)}`,
        targetType: "gateway-session",
    });

    try {
        await store.append(event);
        expect(database.orm.select().from(auditEvents).all()).toEqual([
            expect.objectContaining({
                action: "gateway.sessions.reset",
                outcome: "attempted",
                targetId: `sha256:${"a".repeat(64)}`,
            }),
        ]);
    } finally {
        database.sqlite.close(true);
    }
});
