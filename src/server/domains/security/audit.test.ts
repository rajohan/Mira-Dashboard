import { describe, expect, test } from "bun:test";

import { createSecurityAuditEvent, serializeRedactedAuditMetadata } from "./audit.ts";

describe("security audit boundary", () => {
    test("persists only explicitly allowlisted non-secret metadata", () => {
        const metadata = JSON.parse(
            serializeRedactedAuditMetadata({
                password: "do-not-store",
                reason: "invalid_credentials",
                requestBody: { username: "operator" },
                safe: { nested: { deeper: { value: "hidden" } } },
                token: "do-not-store",
            })
        ) as Record<string, unknown>;

        expect(metadata).toEqual({ reason: "invalid_credentials" });
    });

    test("builds a validated audit row without optional secret leakage", () => {
        const event = createSecurityAuditEvent({
            action: "auth.login",
            actor: { authenticatorId: null, id: "browser", kind: "anonymous" },
            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
            metadata: { reason: "invalid_credentials" },
            occurredAt: new Date("2026-08-05T09:00:00.000Z"),
            outcome: "denied",
            requestId: "request-1",
            targetId: "unknown",
            targetType: "user",
        });

        expect(event.metadataJson).toBe('{"reason":"invalid_credentials"}');
        expect(event.authenticatorId).toBeNull();
    });
});
