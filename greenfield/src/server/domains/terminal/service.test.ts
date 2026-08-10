import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { terminalConnectionTicketTtlMs } from "../../../contracts/terminal.ts";
import { createTerminalRootRegistry } from "../../platform/terminal/rootRegistry.ts";
import { TerminalSessionBrokerError, type TerminalSessionBroker } from "./brokerPort.ts";
import type { TerminalOperationAuditEvent } from "./operationAudit.ts";
import { createTerminalService } from "./service.ts";

const sessionId = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
const actor = Object.freeze({ authenticatorId: "auth-session", id: "user-1" });
const auditContext = Object.freeze({
    actor: { ...actor, kind: "user" as const },
    requestId: "request-1",
});
const now = 1_800_000_000_000;
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function fixture(
    overrides: {
        readonly auditRecord?: (event: TerminalOperationAuditEvent) => Promise<void>;
        readonly broker?: Partial<TerminalSessionBroker>;
    } = {}
) {
    const root = await mkdtemp(path.join(tmpdir(), "mira-terminal-service-"));
    temporaryDirectories.push(root);
    const roots = await createTerminalRootRegistry([
        { absolutePath: root, id: "workspace", label: "Workspace" },
    ]);
    const calls: string[] = [];
    const summary = {
        dimensions: { columns: 120, rows: 40 },
        expiresAtMs: now + 30 * 60_000,
        idleExpiresAtMs: now + 10 * 60_000,
        location: { path: "/", rootId: "workspace" },
        nextSequence: 1,
        replayAvailableFromSequence: 1,
        sessionId,
        startedAtMs: now,
        state: "awaiting-connection" as const,
    };
    const activeSessions: (typeof summary)[] = [];
    const broker: TerminalSessionBroker = {
        getActive() {
            calls.push("active");
            return Promise.resolve(activeSessions.at(0));
        },
        prepareResume() {
            calls.push("resume");
            return Promise.resolve(summary);
        },
        reserve() {
            calls.push("reserve");
            return Promise.resolve(summary);
        },
        terminate() {
            calls.push("terminate");
            return Promise.resolve();
        },
        ...overrides.broker,
    };
    const auditEvents: TerminalOperationAuditEvent[] = [];
    const service = createTerminalService({
        auditWriter: {
            async record(event) {
                calls.push(`audit:${event.settlement}`);
                auditEvents.push(event);
                await overrides.auditRecord?.(event);
            },
        },
        broker,
        generateId: () => sessionId,
        nowMs: () => now,
        roots,
    });
    return { auditEvents, calls, service };
}

describe("interactive terminal service", () => {
    test("durably audits before reserving and returns a bounded one-time ticket", async () => {
        const { auditEvents, calls, service } = await fixture();
        const result = await service.prepareSession(
            actor,
            {
                dimensions: { columns: 120, rows: 40 },
                location: { path: "/", rootId: "workspace" },
            },
            auditContext
        );

        expect(calls).toEqual(["audit:attempted", "reserve", "audit:succeeded"]);
        expect(result).toMatchObject({
            afterSequence: 0,
            expiresAtMs: now + terminalConnectionTicketTtlMs,
            sessionId,
            webSocketProtocol: "mira-terminal-v1",
        });
        expect(auditEvents).toEqual([
            expect.objectContaining({
                operation: "prepare",
                rootId: "workspace",
                settlement: "attempted",
            }),
            expect.objectContaining({
                operation: "prepare",
                rootId: "workspace",
                settlement: "succeeded",
            }),
        ]);
        expect(JSON.stringify(auditEvents)).not.toContain("connectionToken");
    });

    test("fails closed before process reservation when attempted audit is unavailable", async () => {
        const { calls, service } = await fixture({
            auditRecord: () => Promise.reject(new Error("database unavailable")),
        });

        expect(
            service.prepareSession(
                actor,
                {
                    dimensions: { columns: 80, rows: 24 },
                    location: { path: "/", rootId: "workspace" },
                },
                auditContext
            )
        ).rejects.toMatchObject({ reason: "audit-unavailable" });
        expect(calls).toEqual(["audit:attempted"]);
    });

    test("terminates a reserved PTY if the success audit cannot settle", async () => {
        const { calls, service } = await fixture({
            auditRecord(event) {
                return event.settlement === "succeeded"
                    ? Promise.reject(new Error("audit settlement failed"))
                    : Promise.resolve();
            },
        });

        expect(
            service.prepareSession(
                actor,
                {
                    dimensions: { columns: 80, rows: 24 },
                    location: { path: "/", rootId: "workspace" },
                },
                auditContext
            )
        ).rejects.toMatchObject({ reason: "audit-unavailable" });
        expect(calls).toEqual([
            "audit:attempted",
            "reserve",
            "audit:succeeded",
            "terminate",
            "audit:failed",
        ]);
    });

    test("maps worker capacity safely and preserves resumable replay cursors", async () => {
        const capacity = await fixture({
            broker: {
                reserve: () => Promise.reject(new TerminalSessionBrokerError("capacity")),
            },
        });
        expect(
            capacity.service.prepareSession(
                actor,
                {
                    dimensions: { columns: 80, rows: 24 },
                    location: { path: "/", rootId: "workspace" },
                },
                auditContext
            )
        ).rejects.toMatchObject({ reason: "capacity" });

        const resumed = await fixture();
        const ticket = await resumed.service.prepareResume(
            actor,
            { afterSequence: 42, sessionId },
            auditContext
        );
        expect(ticket.afterSequence).toBe(42);
        expect(resumed.calls).toEqual(["audit:attempted", "resume", "audit:succeeded"]);
    });
});
