import { describe, expect, it } from "bun:test";

import { database } from "../src/database.ts";
import { runWithRequestAuditContext } from "../src/requestAuditContext.ts";
import {
    auditProvenanceForTarget,
    listAuditEvents,
    writeAuditEvent,
} from "../src/services/auditEvents.ts";
import {
    finishJobExecution,
    insertJobExecution,
} from "../src/services/jobExecutionQueue.ts";

describe("append-only audit events", () => {
    it("redacts bounded metadata and rejects update or delete", () => {
        const event = writeAuditEvent({
            actor: { id: "1:operator", type: "user" },
            action: "security.test",
            metadata: {
                command: "safe command name",
                nested: {
                    credential: "must-not-persist",
                    detail: "visible",
                },
                password: "must-not-persist",
                stdout: "must-not-persist",
                target: "visible-target",
            },
            outcome: "succeeded",
            requestId: Bun.randomUUIDv7(),
            targetId: `target-${Bun.randomUUIDv7()}`,
            targetType: "test-target",
        });

        expect(event.metadata).toEqual({
            command: "[redacted]",
            nested: {
                credential: "[redacted]",
                detail: "visible",
            },
            password: "[redacted]",
            stdout: "[redacted]",
            target: "visible-target",
        });
        expect(() =>
            database
                .prepare("UPDATE audit_events SET outcome = 'failed' WHERE id = ?")
                .run(event.id)
        ).toThrow("audit_events is append-only");
        expect(() =>
            database.prepare("DELETE FROM audit_events WHERE id = ?").run(event.id)
        ).toThrow("audit_events is append-only");
        expect(() =>
            database
                .prepare(
                    `INSERT INTO audit_events (
                        id, actor_type, actor_id, action, target_type, target_id,
                        outcome, metadata_json, occurred_at
                     ) VALUES (?, 'system', 'test', 'security.test', 'test-target',
                               'invalid-json', 'failed', 'not-json', ?)`
                )
                .run(Bun.randomUUIDv7(), new Date().toISOString())
        ).toThrow("CHECK constraint failed");
    });

    it("paginates deterministically and preserves target provenance", () => {
        const actor = { id: "mira-automation", type: "automation" } as const;
        const requestId = Bun.randomUUIDv7();
        const targets = [
            `audit-page-a-${Bun.randomUUIDv7()}`,
            `audit-page-b-${Bun.randomUUIDv7()}`,
            `audit-page-c-${Bun.randomUUIDv7()}`,
        ];
        for (const [index, targetId] of targets.entries()) {
            writeAuditEvent({
                actor,
                action: "audit.pagination",
                occurredAt: `2099-01-01T00:00:0${index}.000Z`,
                outcome: "accepted",
                requestId,
                targetId,
                targetType: "test-page",
            });
        }

        const firstPage = listAuditEvents(2);
        expect(firstPage.events.map((event) => event.target.id)).toEqual([
            targets[2]!,
            targets[1]!,
        ]);
        expect(firstPage.nextCursor).toBeDefined();
        const secondPage = listAuditEvents(2, firstPage.nextCursor);
        expect(secondPage.events[0]?.target.id).toBe(targets[0]);
        expect(
            auditProvenanceForTarget("audit.pagination", "test-page", targets[0]!)
        ).toEqual({
            actor,
            requestId,
        });
        expect(() => listAuditEvents(10, "not-a-valid-cursor")).toThrow(
            "Invalid audit cursor"
        );
    });

    it("carries request provenance through worker-owned job completion", () => {
        const requestContext = {
            actor: { id: "3:job-operator", type: "user" } as const,
            requestId: Bun.randomUUIDv7(),
        };
        const jobId = Bun.randomUUIDv7();
        const queuedAt = "2098-01-01T00:00:00.000Z";
        const execution = runWithRequestAuditContext(requestContext, () =>
            insertJobExecution({
                actionKey: "audit.test-job",
                displayName: "Audit test job",
                id: jobId,
                leaseOwner: "audit-test-worker",
                queuedAt,
                resourceClass: "light",
                status: "running",
                timeoutMs: 60_000,
                triggerType: "manual",
            })
        );
        expect(execution.status).toBe("running");

        finishJobExecution(
            jobId,
            "audit-test-worker",
            "success",
            undefined,
            { result: "not copied into audit metadata" },
            "2098-01-01T00:00:01.000Z"
        );

        const rows = database
            .prepare(
                `SELECT actor_type, actor_id, action, outcome, request_id, metadata_json
                 FROM audit_events
                 WHERE target_type = 'job-execution' AND target_id = ?
                 ORDER BY occurred_at, id`
            )
            .all(jobId) as Array<{
            action: string;
            actor_id: string;
            actor_type: string;
            metadata_json: string;
            outcome: string;
            request_id: string | null;
        }>;
        expect(
            rows.map(({ action, actor_id, actor_type, outcome, request_id }) => ({
                action,
                actorId: actor_id,
                actorType: actor_type,
                outcome,
                requestId: request_id,
            }))
        ).toEqual([
            {
                action: "job.enqueue",
                actorId: requestContext.actor.id,
                actorType: "user",
                outcome: "accepted",
                requestId: requestContext.requestId,
            },
            {
                action: "job.execute",
                actorId: requestContext.actor.id,
                actorType: "user",
                outcome: "succeeded",
                requestId: requestContext.requestId,
            },
        ]);
        expect(rows.map((row) => row.metadata_json).join("\n")).not.toContain(
            "not copied into audit metadata"
        );
    });
});
