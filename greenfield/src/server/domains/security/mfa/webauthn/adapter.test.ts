import { describe, expect, spyOn, test } from "bun:test";

import {
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from "@simplewebauthn/server";

import { createWebAuthnAdapter, type WebAuthnStoredCredential } from "./adapter.ts";
import {
    createWebAuthnRelyingPartyConfiguration,
    createWebAuthnUserHandle,
} from "./relyingPartyConfiguration.ts";
import {
    ceremonyFixtureChallenge,
    ceremonyFixtureCredentialId,
    ceremonyFixtureOrigin,
    ceremonyFixturePublicKey,
    ceremonyFixtureRpId,
    createAuthenticationFixture,
    createRegistrationFixture,
} from "./testSupport/ceremonyFixture.ts";

const configuration = createWebAuthnRelyingPartyConfiguration({
    allowedOrigins: [ceremonyFixtureOrigin],
    rpId: ceremonyFixtureRpId,
    rpName: "Mira Dashboard",
});
const userHandle = createWebAuthnUserHandle("0198b8aa-cf3c-7aa2-ae65-c9aa15856575");

function storedCredential(counter = 0): WebAuthnStoredCredential {
    return {
        algorithm: -7,
        counter,
        deviceType: "multiDevice",
        id: ceremonyFixtureCredentialId,
        publicKey: ceremonyFixturePublicKey,
        rpId: ceremonyFixtureRpId,
        transports: ["usb"],
    };
}

describe("WebAuthn adapter", () => {
    test("generates only the fixed ES256 roaming-security-key policy", async () => {
        const adapter = createWebAuthnAdapter(configuration);
        const registration = await adapter.generateRegistrationOptions({
            excludeCredentials: [
                {
                    id: ceremonyFixtureCredentialId,
                    transports: ["usb", "nfc"],
                },
            ],
            userDisplayName: "Dashboard operator",
            userHandle,
            userName: "operator",
        });
        const authentication = await adapter.generateAuthenticationOptions({
            allowCredentials: [
                {
                    id: ceremonyFixtureCredentialId,
                    transports: ["usb", "nfc"],
                },
            ],
        });

        expect(registration.status).toBe("generated");
        expect(authentication.status).toBe("generated");
        if (
            registration.status !== "generated" ||
            authentication.status !== "generated"
        ) {
            throw new Error("WebAuthn options fixture generation failed");
        }
        expect(registration.options).toMatchObject({
            attestation: "none",
            authenticatorSelection: {
                authenticatorAttachment: "cross-platform",
                requireResidentKey: false,
                residentKey: "discouraged",
                userVerification: "required",
            },
            extensions: { credProps: true },
            hints: ["security-key"],
            pubKeyCredParams: [{ alg: -7, type: "public-key" }],
            rp: { id: ceremonyFixtureRpId, name: "Mira Dashboard" },
            timeout: 60_000,
        });
        expect(registration.options.user.id).toBe(userHandle);
        expect(registration.options.excludeCredentials[0]?.transports).toEqual([
            "nfc",
            "usb",
        ]);
        expect(registration.options.challenge).toMatch(/^[A-Za-z\d_-]{43}$/u);
        expect(authentication.options).toMatchObject({
            rpId: ceremonyFixtureRpId,
            timeout: 60_000,
            userVerification: "required",
        });
        expect(authentication.options.allowCredentials[0]?.transports).toEqual([
            "nfc",
            "usb",
        ]);
        expect(authentication.options.challenge).toMatch(/^[A-Za-z\d_-]{43}$/u);
    });

    test("verifies a real fmt-none ES256 registration without returning raw ceremony data", async () => {
        const adapter = createWebAuthnAdapter(configuration);
        const result = await adapter.verifyRegistration({
            expectedChallenge: ceremonyFixtureChallenge,
            response: createRegistrationFixture(),
        });

        expect(result.status).toBe("verified");
        if (result.status !== "verified") {
            throw new Error("WebAuthn registration fixture did not verify");
        }
        expect(result.verification).toEqual({
            credential: {
                algorithm: -7,
                counter: 0,
                id: ceremonyFixtureCredentialId,
                publicKey: ceremonyFixturePublicKey,
                transports: ["usb"],
            },
            credentialBackedUp: true,
            credentialDeviceType: "multiDevice",
        });
        expect(JSON.stringify(result)).not.toContain("attestationObject");
        expect(JSON.stringify(result)).not.toContain("clientDataJSON");
    });

    test("verifies real monotonic 0-to-1 and valid multi-device 0-to-0 assertions", async () => {
        const adapter = createWebAuthnAdapter(configuration);
        const monotonic = await adapter.verifyAuthentication({
            credential: storedCredential(),
            expectedChallenge: ceremonyFixtureChallenge,
            expectedUserHandle: userHandle,
            response: await createAuthenticationFixture({
                counter: 1,
                userHandle,
            }),
        });
        const zeroCounter = await adapter.verifyAuthentication({
            credential: storedCredential(),
            expectedChallenge: ceremonyFixtureChallenge,
            response: await createAuthenticationFixture({ counter: 0 }),
        });

        expect(monotonic).toEqual({
            status: "verified",
            verification: {
                credentialBackedUp: true,
                credentialDeviceType: "multiDevice",
                credentialId: ceremonyFixtureCredentialId,
                newCounter: 1,
            },
        });
        expect(zeroCounter).toEqual({
            status: "verified",
            verification: {
                credentialBackedUp: true,
                credentialDeviceType: "multiDevice",
                credentialId: ceremonyFixtureCredentialId,
                newCounter: 0,
            },
        });
    });

    test("rejects hostile origins, cross-origin ceremonies, and credential id mismatches", async () => {
        const adapter = createWebAuthnAdapter(configuration);
        const hostileRegistration = await adapter.verifyRegistration({
            expectedChallenge: ceremonyFixtureChallenge,
            response: createRegistrationFixture({ origin: "https://attacker.example" }),
        });
        const crossOriginRegistration = await adapter.verifyRegistration({
            expectedChallenge: ceremonyFixtureChallenge,
            response: createRegistrationFixture({ crossOrigin: true }),
        });
        const mismatchedRegistrationId = await adapter.verifyRegistration({
            expectedChallenge: ceremonyFixtureChallenge,
            response: createRegistrationFixture({ rawId: "AAAAAAAA" }),
        });
        const hostileAuthentication = await adapter.verifyAuthentication({
            credential: storedCredential(),
            expectedChallenge: ceremonyFixtureChallenge,
            response: await createAuthenticationFixture({
                counter: 1,
                origin: "https://attacker.example",
            }),
        });
        const crossOriginAuthentication = await adapter.verifyAuthentication({
            credential: storedCredential(),
            expectedChallenge: ceremonyFixtureChallenge,
            response: await createAuthenticationFixture({
                counter: 1,
                crossOrigin: true,
            }),
        });
        const mismatchedAuthenticationId = await adapter.verifyAuthentication({
            credential: storedCredential(),
            expectedChallenge: ceremonyFixtureChallenge,
            response: await createAuthenticationFixture({
                counter: 1,
                id: "AAAAAAAA",
            }),
        });

        for (const result of [
            hostileRegistration,
            crossOriginRegistration,
            mismatchedRegistrationId,
            hostileAuthentication,
            crossOriginAuthentication,
            mismatchedAuthenticationId,
        ]) {
            expect(result).toEqual({ status: "invalid-proof" });
        }
    });

    test("requires a supplied opaque handle to match when an assertion returns one", async () => {
        const adapter = createWebAuthnAdapter(configuration);
        const response = await createAuthenticationFixture({
            counter: 1,
            userHandle,
        });

        expect(
            await adapter.verifyAuthentication({
                credential: storedCredential(),
                expectedChallenge: ceremonyFixtureChallenge,
                expectedUserHandle: createWebAuthnUserHandle(
                    "0198b8aa-cf3c-7aa2-ae65-c9aa15856576"
                ),
                response,
            })
        ).toEqual({ status: "invalid-proof" });
        expect(
            await adapter.verifyAuthentication({
                credential: storedCredential(),
                expectedChallenge: ceremonyFixtureChallenge,
                response,
            })
        ).toEqual({ status: "invalid-proof" });
    });

    test("rejects non-none attestation before entering any verifier or fetch-capable path", async () => {
        let verifierCalls = 0;
        const fetchSpy = spyOn(globalThis, "fetch");
        try {
            const adapter = createWebAuthnAdapter(configuration, {
                verifyRegistrationResponse: () => {
                    verifierCalls += 1;
                    return Promise.resolve({ verified: false });
                },
            });

            expect(
                await adapter.verifyRegistration({
                    expectedChallenge: ceremonyFixtureChallenge,
                    response: createRegistrationFixture({ format: "packed" }),
                })
            ).toEqual({ status: "invalid-proof" });
            expect(verifierCalls).toBe(0);
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    test("rejects a verified registration whose embedded credential id differs", async () => {
        const adapter = createWebAuthnAdapter(configuration, {
            verifyRegistrationResponse: async (input) => {
                const result = await verifyRegistrationResponse(input);
                if (!result.verified) return result;
                return {
                    ...result,
                    registrationInfo: {
                        ...result.registrationInfo,
                        credential: {
                            ...result.registrationInfo.credential,
                            id: "AAAAAAAA",
                        },
                    },
                };
            },
        });

        expect(
            await adapter.verifyRegistration({
                expectedChallenge: ceremonyFixtureChallenge,
                response: createRegistrationFixture(),
            })
        ).toEqual({ status: "invalid-proof" });
    });

    test("rejects verified assertions whose credential device type drifts", async () => {
        const adapter = createWebAuthnAdapter(configuration, {
            verifyAuthenticationResponse: async (input) => {
                const result = await verifyAuthenticationResponse(input);
                if (!result.verified) return result;
                return {
                    ...result,
                    authenticationInfo: {
                        ...result.authenticationInfo,
                        credentialDeviceType: "singleDevice",
                    },
                };
            },
        });

        expect(
            await adapter.verifyAuthentication({
                credential: storedCredential(),
                expectedChallenge: ceremonyFixtureChallenge,
                response: await createAuthenticationFixture({ counter: 1 }),
            })
        ).toEqual({ status: "invalid-proof" });
    });

    test("maps dependency failures to non-sensitive tagged results", async () => {
        const secretFailureText = "raw-attestation-secret-should-never-escape";
        const adapter = createWebAuthnAdapter(configuration, {
            generateAuthenticationOptions: () => {
                throw new Error(secretFailureText);
            },
            verifyRegistrationResponse: () => {
                throw new Error(secretFailureText);
            },
        });
        const generation = await adapter.generateAuthenticationOptions({
            allowCredentials: [{ id: ceremonyFixtureCredentialId }],
        });
        const verification = await adapter.verifyRegistration({
            expectedChallenge: ceremonyFixtureChallenge,
            response: createRegistrationFixture(),
        });

        expect(generation).toEqual({ status: "unavailable" });
        expect(verification).toEqual({ status: "invalid-proof" });
        expect(JSON.stringify({ generation, verification })).not.toContain(
            secretFailureText
        );
    });
});
