import { describe, expect, test } from "bun:test";

import { createSecurityAuditEvent, serializeRedactedAuditMetadata } from "./audit.ts";

const parseUnknownJson = (value: string): unknown => JSON.parse(value) as unknown;

describe("security audit boundary", () => {
    test("persists only explicitly allowlisted non-secret metadata", () => {
        const metadata = parseUnknownJson(
            serializeRedactedAuditMetadata({
                password: "do-not-store",
                reason: "invalid_credentials",
                requestBody: { username: "operator" },
                safe: { nested: { deeper: { value: "hidden" } } },
                token: "do-not-store",
            })
        );

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

    test("redacts raw WebAuthn ceremony material", () => {
        const metadata = parseUnknownJson(
            serializeRedactedAuditMetadata({
                attestationObject: "raw-attestation",
                challenge: "raw-challenge",
                clientDataJSON: "raw-client-data",
                method: "webauthn",
                publicKey: "raw-public-key",
                reason: "webauthn_invalid",
                response: { signature: "raw-signature" },
            })
        );

        expect(metadata).toEqual({
            method: "webauthn",
            reason: "webauthn_invalid",
        });
    });

    test("retains only validated automation administration metadata", () => {
        const metadata = parseUnknownJson(
            serializeRedactedAuditMetadata({
                addedCapabilities: ["reports:read", "notifications:read"],
                predecessorCredentialId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                removedCapabilities: ["notifications:read"],
                replacementCredentialId: "019fc968-1a9b-7771-8f1b-d5b863b0e7b4",
                revokedCredentials: 2,
                token: "never-persist",
                validatorHash: "never-persist",
            })
        );

        expect(metadata).toEqual({
            addedCapabilities: ["notifications:read", "reports:read"],
            predecessorCredentialId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
            removedCapabilities: ["notifications:read"],
            replacementCredentialId: "019fc968-1a9b-7771-8f1b-d5b863b0e7b4",
            revokedCredentials: 2,
        });
    });

    test("retains only classified external-operation settlement values", () => {
        expect(
            parseUnknownJson(
                serializeRedactedAuditMetadata({
                    settlement: "partial",
                    targetId: "private-provider-id",
                })
            )
        ).toEqual({ settlement: "partial" });
        expect(
            parseUnknownJson(serializeRedactedAuditMetadata({ settlement: "uncertain" }))
        ).toEqual({});
    });
});
