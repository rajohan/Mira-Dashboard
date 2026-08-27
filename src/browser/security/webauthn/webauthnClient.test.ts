import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import type {
    WebAuthnAuthenticationOptions,
    WebAuthnAuthenticationResponse,
    WebAuthnRegistrationOptions,
    WebAuthnRegistrationResponse,
} from "../../../contracts/webauthn.ts";
import {
    createDashboardWebAuthnClient,
    createSimpleWebAuthnCeremonyPort,
    type DashboardWebAuthnCeremonyPort,
} from "./webauthnClient.ts";

const authenticationOptions = {
    allowCredentials: [{ id: "AAAAAAAA", type: "public-key" }],
    challenge: "A".repeat(32),
    rpId: "localhost",
    timeout: 60_000,
    userVerification: "required",
} satisfies WebAuthnAuthenticationOptions;

const authenticationResponse = {
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: {},
    id: "AAAAAAAA",
    rawId: "AAAAAAAA",
    response: {
        authenticatorData: "AAAA",
        clientDataJSON: "AAAA",
        signature: "AAAA",
    },
    type: "public-key",
} satisfies WebAuthnAuthenticationResponse;

const registrationOptions = {
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
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    rp: { id: "localhost", name: "Mira Dashboard" },
    timeout: 60_000,
    user: {
        displayName: "Operator",
        id: "A".repeat(16),
        name: "operator",
    },
} satisfies WebAuthnRegistrationOptions;

const registrationResponse = {
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: { credProps: { rk: false } },
    id: "BBBBBBBB",
    rawId: "BBBBBBBB",
    response: {
        attestationObject: "AAAA",
        authenticatorData: "AAAA",
        clientDataJSON: "AAAA",
        publicKey: "AAAA",
        publicKeyAlgorithm: -7,
        transports: ["usb"],
    },
    type: "public-key",
} satisfies WebAuthnRegistrationResponse;

describe("Dashboard WebAuthn client", () => {
    test("adapts eagerly loaded SimpleWebAuthn ceremonies without a click-time import", async () => {
        const calls: unknown[] = [];
        const ceremonies = createSimpleWebAuthnCeremonyPort({
            startAuthentication: (input) => {
                calls.push(input);
                return Promise.resolve(authenticationResponse);
            },
            startRegistration: (input) => {
                calls.push(input);
                return Promise.resolve(registrationResponse);
            },
        });

        expect(await ceremonies.beginAuthentication(authenticationOptions)).toEqual(
            authenticationResponse
        );
        expect(await ceremonies.beginRegistration(registrationOptions)).toEqual(
            registrationResponse
        );
        expect(calls).toEqual([
            { optionsJSON: authenticationOptions },
            { optionsJSON: registrationOptions },
        ]);
    });

    test("passes exact options to the browser port and validates both responses", async () => {
        const calls: unknown[] = [];
        const ceremonies: DashboardWebAuthnCeremonyPort = Object.freeze({
            beginAuthentication: (options: WebAuthnAuthenticationOptions) => {
                calls.push(options);
                return Promise.resolve(authenticationResponse);
            },
            beginRegistration: (options: WebAuthnRegistrationOptions) => {
                calls.push(options);
                return Promise.resolve(registrationResponse);
            },
        });
        const client = createDashboardWebAuthnClient(ceremonies);

        expect(await client.authenticate(authenticationOptions)).toEqual(
            authenticationResponse
        );
        expect(await client.register(registrationOptions)).toEqual(registrationResponse);
        expect(calls).toEqual([authenticationOptions, registrationOptions]);
    });

    test("rejects a malformed authentication response at the browser boundary", () => {
        const ceremonies: DashboardWebAuthnCeremonyPort = Object.freeze({
            beginAuthentication: () =>
                Promise.resolve({
                    ...authenticationResponse,
                    rawId: "CCCCCCCC",
                }),
            beginRegistration: () => Promise.resolve(registrationResponse),
        });

        expect(
            createDashboardWebAuthnClient(ceremonies).authenticate(authenticationOptions)
        ).rejects.toBeInstanceOf(v.ValiError);
    });

    test("rejects a malformed registration response at the browser boundary", () => {
        const ceremonies: DashboardWebAuthnCeremonyPort = Object.freeze({
            beginAuthentication: () => Promise.resolve(authenticationResponse),
            beginRegistration: () =>
                Promise.resolve({
                    ...registrationResponse,
                    response: {
                        ...registrationResponse.response,
                        publicKeyAlgorithm: -257,
                    },
                }),
        });

        expect(
            createDashboardWebAuthnClient(ceremonies).register(registrationOptions)
        ).rejects.toBeInstanceOf(v.ValiError);
    });
});
