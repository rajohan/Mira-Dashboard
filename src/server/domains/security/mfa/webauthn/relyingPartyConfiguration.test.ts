import { describe, expect, test } from "bun:test";

import {
    createWebAuthnRelyingPartyConfiguration,
    createWebAuthnUserHandle,
    WebAuthnRelyingPartyConfigurationError,
} from "./relyingPartyConfiguration.ts";

describe("WebAuthn relying-party configuration", () => {
    test("canonicalizes one explicit immutable origin allowlist and fingerprint", () => {
        const first = createWebAuthnRelyingPartyConfiguration({
            allowedOrigins: [
                "https://admin.dashboard.example:8443",
                "https://dashboard.example",
            ],
            rpId: "dashboard.example",
            rpName: "  Mira Dashboard  ",
        });
        const second = createWebAuthnRelyingPartyConfiguration({
            allowedOrigins: [
                "https://dashboard.example",
                "https://admin.dashboard.example:8443",
            ],
            rpId: "dashboard.example",
            rpName: "Mira Dashboard",
        });

        expect(first).toEqual(second);
        expect(first.allowedOrigins).toEqual([
            "https://admin.dashboard.example:8443",
            "https://dashboard.example",
        ]);
        expect(first.fingerprint).toMatch(/^[a-f\d]{64}$/u);
        expect(Object.isFrozen(first)).toBeTrue();
        expect(Object.isFrozen(first.allowedOrigins)).toBeTrue();
    });

    test("rejects origins that are insecure, non-canonical, duplicated, or outside the RP ID", () => {
        const invalidOrigins = [
            ["http://dashboard.example"],
            ["https://attacker.example"],
            ["https://dashboard.example/path"],
            ["https://dashboard.example", "https://dashboard.example"],
            [],
        ];

        for (const allowedOrigins of invalidOrigins) {
            expect(() =>
                createWebAuthnRelyingPartyConfiguration({
                    allowedOrigins,
                    rpId: "dashboard.example",
                    rpName: "Mira Dashboard",
                })
            ).toThrow(WebAuthnRelyingPartyConfigurationError);
        }
    });

    test("permits only the localhost HTTP secure-context exception", () => {
        expect(
            createWebAuthnRelyingPartyConfiguration({
                allowedOrigins: ["http://localhost:3100"],
                rpId: "localhost",
                rpName: "Mira Dashboard",
            }).allowedOrigins
        ).toEqual(["http://localhost:3100"]);
        expect(() =>
            createWebAuthnRelyingPartyConfiguration({
                allowedOrigins: ["http://localhost:3100"],
                rpId: "dashboard.example",
                rpName: "Mira Dashboard",
            })
        ).toThrow(WebAuthnRelyingPartyConfigurationError);
    });

    test("derives stable opaque 32-byte handles without usernames or email addresses", () => {
        const first = createWebAuthnUserHandle("0198b8aa-cf3c-7aa2-ae65-c9aa15856575");
        const again = createWebAuthnUserHandle("0198b8aa-cf3c-7aa2-ae65-c9aa15856575");
        const other = createWebAuthnUserHandle("0198b8aa-cf3c-7aa2-ae65-c9aa15856576");

        expect(first).toBe(again);
        expect(first).not.toBe(other);
        expect(first).toMatch(/^[A-Za-z\d_-]{43}$/u);
        expect(first).not.toContain("0198b8aa");
        expect(() => createWebAuthnUserHandle("operator@example.com\n")).toThrow(
            "WebAuthn user identity is invalid"
        );
    });
});
