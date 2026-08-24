import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    listSecurityAuditEventsInputSchema,
    listSecurityAuditEventsResultSchema,
} from "./securityAudit.ts";

const firstId = "019fc968-1a9b-7772-8f1b-d5b863b0e7b4";
const secondId = "019fc968-1a9b-7771-8f1b-d5b863b0e7b4";

function event(id: string, occurredAtMs: number) {
    return {
        action: "auth.session.revoke-all",
        actor: {
            authenticatorId: "a".repeat(32),
            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
            kind: "user" as const,
        },
        id,
        metadata: { revokedSessions: 2 },
        occurredAtMs,
        outcome: "succeeded" as const,
        requestId: "request-audit-list",
        target: {
            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
            type: "auth_sessions",
        },
    };
}

describe("security audit contracts", () => {
    test("defaults and bounds the newest-first list input", () => {
        expect(v.parse(listSecurityAuditEventsInputSchema, {})).toEqual({
            limit: 20,
        });
        expect(
            v.safeParse(listSecurityAuditEventsInputSchema, { limit: 51 }).success
        ).toBeFalse();
        expect(
            v.safeParse(listSecurityAuditEventsInputSchema, {
                extra: true,
                limit: 1,
            }).success
        ).toBeFalse();
    });

    test("requires stable event order and a cursor matching the last row", () => {
        const first = event(firstId, 1_800_000_000_000);
        const second = event(secondId, 1_800_000_000_000);
        expect(
            v.parse(listSecurityAuditEventsResultSchema, {
                events: [first, second],
                nextCursor: {
                    id: second.id,
                    occurredAtMs: second.occurredAtMs,
                },
            }).events
        ).toHaveLength(2);
        expect(
            v.safeParse(listSecurityAuditEventsResultSchema, {
                events: [second, first],
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(listSecurityAuditEventsResultSchema, {
                events: [first, second],
                nextCursor: {
                    id: first.id,
                    occurredAtMs: first.occurredAtMs,
                },
            }).success
        ).toBeFalse();
    });

    test("rejects actor mismatches and unclassified metadata", () => {
        const valid = event(firstId, 1_800_000_000_000);
        expect(
            v.safeParse(listSecurityAuditEventsResultSchema, {
                events: [
                    {
                        ...valid,
                        actor: { id: valid.actor.id, kind: "user" },
                    },
                ],
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(listSecurityAuditEventsResultSchema, {
                events: [
                    {
                        ...valid,
                        metadata: { credential: "must-not-escape" },
                    },
                ],
            }).success
        ).toBeFalse();
    });
});
