import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    webAuthnAuthenticationResponseSchema,
    webAuthnRegistrationOptionsSchema,
    webAuthnRegistrationResponseSchema,
    webAuthnSupportedAlgorithm,
} from "./webauthn.ts";

const credentialId = "AdKXJEch1aV5Wo7bj7qLHskVY4OoNaj9qu8TPdJ7kSAgUeRx";

describe("WebAuthn contracts", () => {
    test("accepts one strict bounded registration response", () => {
        const response = {
            clientExtensionResults: {},
            id: credentialId,
            rawId: credentialId,
            response: {
                attestationObject: "AQID",
                clientDataJSON: "AQID",
                transports: ["usb", "nfc"],
            },
            type: "public-key",
        } as const;

        expect(v.parse(webAuthnRegistrationResponseSchema, response)).toEqual({
            ...response,
            response: { ...response.response, transports: ["nfc", "usb"] },
        });
        expect(() =>
            v.parse(webAuthnRegistrationResponseSchema, {
                ...response,
                rawId: `${credentialId}x`,
            })
        ).toThrow();
        expect(() =>
            v.parse(webAuthnRegistrationResponseSchema, {
                ...response,
                unexpected: true,
            })
        ).toThrow();
    });

    test("rejects padded, oversized, and duplicate browser fields", () => {
        const response = {
            clientExtensionResults: {},
            id: credentialId,
            rawId: credentialId,
            response: {
                attestationObject: "AQID",
                clientDataJSON: "AQID",
                transports: ["usb"],
            },
            type: "public-key",
        } as const;

        for (const invalidId of [`${credentialId}=`, "short", "x".repeat(1025)]) {
            expect(() =>
                v.parse(webAuthnRegistrationResponseSchema, {
                    ...response,
                    id: invalidId,
                    rawId: invalidId,
                })
            ).toThrow();
        }
        expect(() =>
            v.parse(webAuthnRegistrationResponseSchema, {
                ...response,
                response: { ...response.response, transports: ["usb", "usb"] },
            })
        ).toThrow();
    });

    test("accepts the strict authentication assertion shape", () => {
        expect(
            v.parse(webAuthnAuthenticationResponseSchema, {
                clientExtensionResults: {},
                id: credentialId,
                rawId: credentialId,
                response: {
                    authenticatorData: "AQID",
                    clientDataJSON: "AQID",
                    signature: "AQID",
                },
                type: "public-key",
            }).id
        ).toBe(credentialId);
    });

    test("rejects non-canonical unpadded base64url encodings", () => {
        const response = {
            clientExtensionResults: {},
            id: credentialId,
            rawId: credentialId,
            response: {
                authenticatorData: "AQID",
                clientDataJSON: "AQID",
                signature: "AQID",
            },
            type: "public-key",
        } as const;

        for (const clientDataJSON of ["A", "AB", "ABC", "AAAAA"]) {
            expect(() =>
                v.parse(webAuthnAuthenticationResponseSchema, {
                    ...response,
                    response: { ...response.response, clientDataJSON },
                })
            ).toThrow();
        }
    });

    test("locks generated registration options to roaming ES256 keys", () => {
        const options = v.parse(webAuthnRegistrationOptionsSchema, {
            attestation: "none",
            authenticatorSelection: {
                authenticatorAttachment: "cross-platform",
                requireResidentKey: false,
                residentKey: "discouraged",
                userVerification: "required",
            },
            challenge: "A".repeat(32),
            excludeCredentials: [],
            extensions: { credProps: true },
            hints: ["security-key"],
            pubKeyCredParams: [{ alg: webAuthnSupportedAlgorithm, type: "public-key" }],
            rp: { id: "dashboard.example.com", name: "Mira Dashboard" },
            timeout: 60_000,
            user: {
                displayName: "Dashboard user",
                id: "A".repeat(16),
                name: "dashboard-user",
            },
        });

        expect(options.pubKeyCredParams).toEqual([
            { alg: webAuthnSupportedAlgorithm, type: "public-key" },
        ]);
    });
});
