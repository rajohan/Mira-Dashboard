import { describe, expect, test } from "bun:test";

import type { SecurityAuditEvent } from "../security/audit.ts";
import {
    createGatewaySessionControlAudit,
    fingerprintGatewaySessionControlTarget,
    type GatewaySessionControlAuditSettlementFailure,
} from "./controlAudit.ts";

const actor = Object.freeze({
    authenticatorId: "a".repeat(32),
    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "user" as const,
});
const requestId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b5";

describe("Gateway session control audit", () => {
    test("durably records attempted and terminal outcomes with only a target fingerprint", async () => {
        const events: SecurityAuditEvent[] = [];
        const ids = [
            "019fc968-1a9b-7770-8f1b-d5b863b0e7b6",
            "019fc968-1a9b-7770-8f1b-d5b863b0e7b7",
        ];
        const sensitiveKey = `agent:${"private-identity".repeat(40)}`.slice(0, 512);
        const audit = createGatewaySessionControlAudit({
            generateId: () => ids.shift() ?? Bun.randomUUIDv7(),
            now: () => new Date(1_800_000_000_000),
            store: {
                append: (event) => {
                    events.push(event);
                    return Promise.resolve();
                },
            },
        });

        const attempt = await audit.begin({
            action: "delete",
            context: { actor, requestId },
            key: sensitiveKey,
        });
        expect(await audit.settle(attempt, "succeeded")).toBe("settled");

        const fingerprint = fingerprintGatewaySessionControlTarget(sensitiveKey);
        expect(sensitiveKey).toHaveLength(512);
        expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(events).toEqual([
            expect.objectContaining({
                action: "gateway.sessions.delete",
                actorId: actor.id,
                actorKind: "user",
                authenticatorId: actor.authenticatorId,
                metadataJson: "{}",
                outcome: "attempted",
                requestId,
                targetId: fingerprint,
                targetType: "gateway-session",
            }),
            expect.objectContaining({
                action: "gateway.sessions.delete",
                outcome: "succeeded",
                requestId,
                targetId: fingerprint,
                targetType: "gateway-session",
            }),
        ]);
        expect(JSON.stringify({ attempt, events })).not.toContain(sensitiveKey);
        expect(fingerprint.length).toBeLessThanOrEqual(256);
    });

    test("fails the pre-dispatch boundary when the attempted row cannot be appended", async () => {
        const audit = createGatewaySessionControlAudit({
            store: {
                append: () => Promise.reject(new Error("private database detail")),
            },
        });

        let failure: unknown;
        try {
            await audit.begin({
                action: "reset",
                context: { actor, requestId },
                key: "agent:coder:main",
            });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
    });

    test("reports a terminal append failure without changing the known outcome", async () => {
        let appendCall = 0;
        const failures: GatewaySessionControlAuditSettlementFailure[] = [];
        const audit = createGatewaySessionControlAudit({
            onSettlementFailure: (failure) => failures.push(failure),
            store: {
                append: () => {
                    appendCall += 1;
                    return appendCall === 1
                        ? Promise.resolve()
                        : Promise.reject(new Error("private settlement detail"));
                },
            },
        });
        const attempt = await audit.begin({
            action: "compact",
            context: { actor, requestId },
            key: "agent:coder:main",
        });

        expect(await audit.settle(attempt, "failed")).toBe("partial");
        expect(failures).toEqual([
            expect.objectContaining({
                action: "compact",
                outcome: "failed",
                requestId,
                targetFingerprint: attempt.targetFingerprint,
            }),
        ]);
        expect(JSON.stringify(failures)).not.toContain("agent:coder:main");
    });

    test("persists an unknown provider outcome as failed with partial metadata", async () => {
        const events: SecurityAuditEvent[] = [];
        const audit = createGatewaySessionControlAudit({
            now: () => new Date(1_800_000_000_000),
            store: {
                append: (event) => {
                    events.push(event);
                    return Promise.resolve();
                },
            },
        });
        const attempt = await audit.begin({
            action: "reset",
            context: { actor, requestId },
            key: "agent:coder:main",
        });

        expect(await audit.settle(attempt, "partial")).toBe("settled");
        expect(events[1]).toMatchObject({
            action: "gateway.sessions.reset",
            metadataJson: '{"settlement":"partial"}',
            outcome: "failed",
            requestId,
        });
    });
});
