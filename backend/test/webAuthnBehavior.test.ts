import type {
    AuthenticationResponseJSON,
    RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { afterEach, describe, expect, it } from "bun:test";

import { createSession, createUser, getAuthSessionFromSessionId } from "../src/auth.ts";
import { database } from "../src/database.ts";
import { createPendingLogin, getPendingLogin } from "../src/services/multiFactorAuth.ts";
import {
    createWebAuthnAuthenticationOptions,
    createWebAuthnRegistrationOptions,
    didRemoveWebAuthnCredential,
    validateWebAuthnConfig,
    verifyWebAuthnAuthentication,
    verifyWebAuthnRegistration,
    type WebAuthnChallengeContext,
    webAuthnConfig,
    type WebAuthnServerAdapter,
} from "../src/services/webAuthn.ts";

const USER_PREFIX = "webauthn-test-";
const originalRpId = process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID;
const originalOrigins = process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS;

type AuthenticationOptions = Awaited<
    ReturnType<WebAuthnServerAdapter["generateAuthenticationOptions"]>
>;
type AuthenticationVerification = Awaited<
    ReturnType<WebAuthnServerAdapter["verifyAuthenticationResponse"]>
>;
type RegistrationOptions = Awaited<
    ReturnType<WebAuthnServerAdapter["generateRegistrationOptions"]>
>;
type RegistrationVerification = Awaited<
    ReturnType<WebAuthnServerAdapter["verifyRegistrationResponse"]>
>;

function configureWebAuthn(): void {
    process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID = "dashboard.example.com";
    process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS =
        "https://dashboard.example.com,https://admin.dashboard.example.com";
}

function restoreEnvironment(): void {
    if (originalRpId === undefined) {
        delete process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID;
    } else {
        process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID = originalRpId;
    }
    if (originalOrigins === undefined) {
        delete process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS;
    } else {
        process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS = originalOrigins;
    }
}

function registrationOptions(challenge = "registration-challenge"): RegistrationOptions {
    return {
        attestation: "none",
        authenticatorSelection: {
            authenticatorAttachment: "cross-platform",
            residentKey: "discouraged",
            requireResidentKey: false,
            userVerification: "required",
        },
        challenge,
        excludeCredentials: [],
        extensions: {},
        hints: ["security-key"],
        pubKeyCredParams: [{ alg: -7, type: "public-key" }],
        rp: {
            id: "dashboard.example.com",
            name: "Mira Dashboard",
        },
        timeout: 60_000,
        user: {
            displayName: "raymond",
            id: "bWlyYS11c2VyOjE",
            name: "raymond",
        },
    };
}

function authenticationOptions(
    challenge = "authentication-challenge"
): AuthenticationOptions {
    return {
        allowCredentials: [],
        challenge,
        rpId: "dashboard.example.com",
        timeout: 60_000,
        userVerification: "required",
    };
}

function registrationVerification(
    credentialId: string,
    overrides: Partial<RegistrationVerification> = {}
): RegistrationVerification {
    return {
        registrationInfo: {
            aaguid: "00000000-0000-0000-0000-000000000000",
            attestationObject: new Uint8Array([1]),
            credential: {
                counter: 0,
                id: credentialId,
                publicKey: new Uint8Array([1, 2, 3]),
                transports: ["usb"],
            },
            credentialBackedUp: false,
            credentialDeviceType: "singleDevice",
            fmt: "none",
            origin: "https://dashboard.example.com",
            rpID: "dashboard.example.com",
            userVerified: true,
        },
        verified: true,
        ...overrides,
    } as RegistrationVerification;
}

function authenticationVerification(
    newCounter: number,
    overrides: Partial<AuthenticationVerification> = {}
): AuthenticationVerification {
    return {
        authenticationInfo: {
            credentialBackedUp: false,
            credentialDeviceType: "singleDevice",
            newCounter,
            origin: "https://dashboard.example.com",
            rpID: "dashboard.example.com",
            userVerified: true,
        },
        verified: true,
        ...overrides,
    } as AuthenticationVerification;
}

function fakeAdapter(
    overrides: Partial<WebAuthnServerAdapter> = {}
): WebAuthnServerAdapter {
    return {
        generateAuthenticationOptions: async () => authenticationOptions(),
        generateRegistrationOptions: async () => registrationOptions(),
        verifyAuthenticationResponse: async () => authenticationVerification(1),
        verifyRegistrationResponse: async () =>
            registrationVerification("credential-default"),
        ...overrides,
    };
}

function registrationResponse(id: string): RegistrationResponseJSON {
    return {
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: {},
        id,
        rawId: id,
        response: {
            attestationObject: "AA",
            clientDataJSON: "AA",
            transports: ["usb"],
        },
        type: "public-key",
    };
}

function authenticationResponse(id: string): AuthenticationResponseJSON {
    return {
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: {},
        id,
        rawId: id,
        response: {
            authenticatorData: "AA",
            clientDataJSON: "AA",
            signature: "AA",
        },
        type: "public-key",
    };
}

function sessionContext(userId: number): WebAuthnChallengeContext {
    const sessionToken = createSession(userId);
    const session = getAuthSessionFromSessionId(sessionToken);
    if (!session) {
        throw new Error("Could not create WebAuthn test session");
    }
    return {
        purpose: "registration",
        sessionId: session.sessionId,
        userId,
    };
}

function insertCredential(
    userId: number,
    id: string,
    transportsJson = '["usb"]',
    counter = 0
): void {
    database
        .prepare(
            `INSERT INTO user_webauthn_credentials (
                id,
                user_id,
                public_key,
                counter,
                transports_json,
                device_type,
                backed_up,
                label,
                created_at
             ) VALUES (?, ?, ?, ?, ?, 'singleDevice', 0, ?, ?)`
        )
        .run(
            id,
            userId,
            new Uint8Array([1, 2, 3]),
            counter,
            transportsJson,
            `Key ${id}`,
            "2026-07-24T12:00:00.000Z"
        );
}

afterEach(() => {
    database.prepare("DELETE FROM users WHERE username LIKE ?").run(`${USER_PREFIX}%`);
    restoreEnvironment();
});

describe("WebAuthn security-key service", () => {
    it("accepts only explicit stable RP IDs and origin-bound HTTPS origins", () => {
        const localDevelopmentOrigin = new URL("https://login.localhost:3100");
        localDevelopmentOrigin.protocol = "http:";
        const insecureProductionOrigin = new URL("https://dashboard.example.com");
        insecureProductionOrigin.protocol = "http:";
        expect(
            webAuthnConfig({
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS:
                    " https://dashboard.example.com,https://dashboard.example.com ",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: " DASHBOARD.EXAMPLE.COM ",
            })
        ).toEqual({
            expectedOrigins: ["https://dashboard.example.com"],
            rpId: "dashboard.example.com",
            rpName: "Mira Dashboard",
        });
        expect(
            webAuthnConfig({
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: localDevelopmentOrigin.origin,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "localhost",
            })
        ).toMatchObject({
            expectedOrigins: [localDevelopmentOrigin.origin],
            rpId: "localhost",
        });

        const invalidConfigurations = [
            {},
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "192.0.2.1",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: `${"a".repeat(254)}.com`,
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "not an origin",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: insecureProductionOrigin.origin,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS:
                    "https://user:password@dashboard.example.com",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com/security",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS:
                    "https://dashboard.example.com?source=test",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com#security",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
            {
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://example.net",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            },
        ] satisfies Array<Record<string, string>>;

        for (const environment of invalidConfigurations) {
            expect(() => webAuthnConfig(environment)).toThrow();
        }
    });

    it("creates user-bound registration options and replaces an outstanding challenge", async () => {
        configureWebAuthn();
        const user = await createUser(`${USER_PREFIX}options`, "initial-password");
        insertCredential(user.id, "credential_existing", "[]");
        insertCredential(user.id, "credential_backup", '["usb","internal","invalid",42]');
        const generatedArguments: unknown[] = [];
        let challengeNumber = 0;
        const adapter = fakeAdapter({
            generateRegistrationOptions: async (arguments_) => {
                generatedArguments.push(arguments_);
                challengeNumber += 1;
                return registrationOptions(`registration-${challengeNumber}`);
            },
        });
        const context = sessionContext(user.id);

        await expect(
            createWebAuthnRegistrationOptions(
                { ...context, purpose: "step-up" },
                user.username,
                new Date("2026-07-24T12:00:00.000Z"),
                adapter
            )
        ).rejects.toThrow("Registration requires");
        await expect(
            createWebAuthnRegistrationOptions(
                {
                    pendingLoginId: "pending",
                    purpose: "registration",
                    sessionId: context.sessionId,
                    userId: user.id,
                },
                user.username,
                new Date(),
                adapter
            )
        ).rejects.toThrow("exactly one");
        await expect(
            createWebAuthnRegistrationOptions(
                {
                    pendingLoginId: "pending",
                    purpose: "registration",
                    userId: user.id,
                },
                user.username,
                new Date(),
                adapter
            )
        ).rejects.toThrow("Invalid WebAuthn challenge context");

        expect(
            await createWebAuthnRegistrationOptions(
                context,
                user.username,
                new Date("2026-07-24T12:00:00.000Z"),
                adapter
            )
        ).toMatchObject({ challenge: "registration-1" });
        expect(
            await createWebAuthnRegistrationOptions(
                context,
                user.username,
                new Date("2026-07-24T12:01:00.000Z"),
                adapter
            )
        ).toMatchObject({ challenge: "registration-2" });
        expect(generatedArguments).toHaveLength(2);
        expect(generatedArguments[0]).toMatchObject({
            attestationType: "none",
            authenticatorSelection: {
                authenticatorAttachment: "cross-platform",
                residentKey: "discouraged",
                userVerification: "required",
            },
            excludeCredentials: [
                { id: "credential_existing", transports: [] },
                { id: "credential_backup", transports: ["usb", "internal"] },
            ],
            preferredAuthenticatorType: "securityKey",
            rpID: "dashboard.example.com",
            userName: user.username,
        });
        expect(
            database
                .prepare(
                    `SELECT challenge
                     FROM auth_webauthn_challenges
                     WHERE user_id = ?`
                )
                .all(user.id)
        ).toEqual([{ challenge: "registration-2" }]);
    });

    it("registers primary and backup keys, consuming every challenge exactly once", async () => {
        configureWebAuthn();
        const user = await createUser(`${USER_PREFIX}register`, "initial-password");
        const context = sessionContext(user.id);
        const now = new Date("2026-07-24T12:00:00.000Z");
        const primaryId = "credential_primary";
        const primaryAdapter = fakeAdapter({
            generateRegistrationOptions: async () => registrationOptions("primary"),
            verifyRegistrationResponse: async (arguments_) => {
                expect(arguments_).toMatchObject({
                    expectedChallenge: "primary",
                    expectedOrigin: [
                        "https://dashboard.example.com",
                        "https://admin.dashboard.example.com",
                    ],
                    expectedRPID: "dashboard.example.com",
                    requireUserPresence: true,
                    requireUserVerification: true,
                });
                return registrationVerification(primaryId);
            },
        });
        await createWebAuthnRegistrationOptions(
            context,
            user.username,
            now,
            primaryAdapter
        );
        const primary = await verifyWebAuthnRegistration(
            context,
            registrationResponse(primaryId),
            " Primary YubiKey ",
            now,
            primaryAdapter
        );
        expect(primary).toMatchObject({
            confirmation: {
                enabledMfa: true,
            },
            credential: {
                backedUp: false,
                deviceType: "singleDevice",
                id: primaryId,
                label: "Primary YubiKey",
            },
        });
        expect(primary?.confirmation.recoveryCodes).toHaveLength(10);
        expect(
            await verifyWebAuthnRegistration(
                context,
                registrationResponse(primaryId),
                "Primary YubiKey",
                now,
                primaryAdapter
            )
        ).toBeUndefined();

        const backupId = "credential_backup";
        const backupTime = new Date(now.getTime() + 1000);
        const backupAdapter = fakeAdapter({
            generateRegistrationOptions: async () => registrationOptions("backup"),
            verifyRegistrationResponse: async () => {
                const result = registrationVerification(backupId);
                result.registrationInfo!.credential.transports = undefined;
                result.registrationInfo!.credentialBackedUp = true;
                result.registrationInfo!.credentialDeviceType = "multiDevice";
                return result;
            },
        });
        await createWebAuthnRegistrationOptions(
            context,
            user.username,
            backupTime,
            backupAdapter
        );
        const backupResponse = registrationResponse(backupId);
        backupResponse.response.transports = ["nfc"];
        const backup = await verifyWebAuthnRegistration(
            context,
            backupResponse,
            "Backup YubiKey",
            backupTime,
            backupAdapter
        );
        expect(backup).toMatchObject({
            confirmation: { enabledMfa: false },
            credential: {
                backedUp: true,
                deviceType: "multiDevice",
                id: backupId,
                label: "Backup YubiKey",
            },
        });
        expect(backup?.confirmation.recoveryCodes).toBeUndefined();
        expect(
            database
                .prepare(
                    `SELECT transports_json
                     FROM user_webauthn_credentials
                     WHERE id = ?`
                )
                .get(backupId)
        ).toEqual({ transports_json: '["nfc"]' });
    });

    it("rejects failed, expired, malformed, and concurrently consumed registrations", async () => {
        configureWebAuthn();
        const user = await createUser(`${USER_PREFIX}register-failure`, "password123");
        const context = sessionContext(user.id);
        const response = registrationResponse("credential_failure");
        const now = new Date("2026-07-24T12:00:00.000Z");
        const unverifiedAt = new Date(now.getTime() + 1000);
        const consumedAt = new Date(now.getTime() + 2000);
        const expiredAt = new Date(now.getTime() + 6 * 60_000);

        expect(
            await verifyWebAuthnRegistration(
                { ...context, purpose: "step-up" },
                response,
                "Key",
                now,
                fakeAdapter()
            )
        ).toBeUndefined();
        expect(
            await verifyWebAuthnRegistration(
                context,
                registrationResponse("bad"),
                "Key",
                now,
                fakeAdapter()
            )
        ).toBeUndefined();
        expect(
            await verifyWebAuthnRegistration(context, response, "Key", now, fakeAdapter())
        ).toBeUndefined();

        const throwingAdapter = fakeAdapter({
            generateRegistrationOptions: async () => registrationOptions("throwing"),
            verifyRegistrationResponse: async () => {
                throw new Error("invalid attestation");
            },
        });
        await createWebAuthnRegistrationOptions(
            context,
            user.username,
            now,
            throwingAdapter
        );
        expect(
            await verifyWebAuthnRegistration(
                context,
                response,
                "Key",
                now,
                throwingAdapter
            )
        ).toBeUndefined();

        const unverifiedAdapter = fakeAdapter({
            generateRegistrationOptions: async () => registrationOptions("unverified"),
            verifyRegistrationResponse: async () =>
                registrationVerification("credential_failure", {
                    verified: false,
                }),
        });
        await createWebAuthnRegistrationOptions(
            context,
            user.username,
            unverifiedAt,
            unverifiedAdapter
        );
        expect(
            await verifyWebAuthnRegistration(
                context,
                response,
                "Key",
                unverifiedAt,
                unverifiedAdapter
            )
        ).toBeUndefined();

        const consumedAdapter = fakeAdapter({
            generateRegistrationOptions: async () => registrationOptions("consumed"),
            verifyRegistrationResponse: async () => {
                database
                    .prepare(
                        `DELETE FROM auth_webauthn_challenges
                         WHERE user_id = ?`
                    )
                    .run(user.id);
                return registrationVerification("credential_failure");
            },
        });
        await createWebAuthnRegistrationOptions(
            context,
            user.username,
            consumedAt,
            consumedAdapter
        );
        expect(
            await verifyWebAuthnRegistration(
                context,
                response,
                "Key",
                consumedAt,
                consumedAdapter
            )
        ).toBeUndefined();

        const expiredAdapter = fakeAdapter({
            generateRegistrationOptions: async () => registrationOptions("expired"),
        });
        await createWebAuthnRegistrationOptions(
            context,
            user.username,
            now,
            expiredAdapter
        );
        expect(
            await verifyWebAuthnRegistration(
                context,
                response,
                "Key",
                expiredAt,
                expiredAdapter
            )
        ).toBeUndefined();
    });

    it("creates and verifies assertions while rejecting challenge and counter races", async () => {
        configureWebAuthn();
        const user = await createUser(`${USER_PREFIX}authenticate`, "password123");
        const registrationContext = sessionContext(user.id);
        const context: WebAuthnChallengeContext = {
            purpose: "step-up",
            sessionId: registrationContext.sessionId,
            userId: user.id,
        };
        const now = new Date("2026-07-24T12:00:00.000Z");
        const credentialId = "credential_assertion";
        insertCredential(user.id, credentialId, '["usb","bogus"]', 4);

        await expect(
            createWebAuthnAuthenticationOptions(registrationContext, now, fakeAdapter())
        ).rejects.toThrow("Authentication requires");
        const emptyUser = await createUser(`${USER_PREFIX}no-credential`, "password123");
        await expect(
            createWebAuthnAuthenticationOptions(
                {
                    purpose: "step-up",
                    sessionId: context.sessionId,
                    userId: emptyUser.id,
                },
                now,
                fakeAdapter()
            )
        ).rejects.toThrow("No WebAuthn credentials");

        const generatedArguments: unknown[] = [];
        const successAdapter = fakeAdapter({
            generateAuthenticationOptions: async (arguments_) => {
                generatedArguments.push(arguments_);
                return authenticationOptions("assertion-success");
            },
            verifyAuthenticationResponse: async (arguments_) => {
                expect(arguments_).toMatchObject({
                    credential: {
                        counter: 4,
                        id: credentialId,
                        transports: ["usb"],
                    },
                    expectedChallenge: "assertion-success",
                    expectedOrigin: [
                        "https://dashboard.example.com",
                        "https://admin.dashboard.example.com",
                    ],
                    expectedRPID: "dashboard.example.com",
                    requireUserVerification: true,
                });
                return authenticationVerification(5);
            },
        });
        expect(
            await createWebAuthnAuthenticationOptions(context, now, successAdapter)
        ).toMatchObject({ challenge: "assertion-success" });
        expect(generatedArguments[0]).toMatchObject({
            allowCredentials: [{ id: credentialId, transports: ["usb"] }],
            rpID: "dashboard.example.com",
            userVerification: "required",
        });
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse(credentialId),
                now,
                successAdapter
            )
        ).toEqual({
            backedUp: false,
            createdAt: "2026-07-24T12:00:00.000Z",
            deviceType: "singleDevice",
            id: credentialId,
            label: `Key ${credentialId}`,
            lastUsedAt: now.toISOString(),
        });
        expect(
            database
                .prepare(
                    `SELECT counter, last_used_at
                     FROM user_webauthn_credentials
                     WHERE id = ?`
                )
                .get(credentialId)
        ).toEqual({
            counter: 5,
            last_used_at: now.toISOString(),
        });

        expect(
            await verifyWebAuthnAuthentication(
                { ...context, purpose: "registration" },
                authenticationResponse(credentialId),
                now,
                successAdapter
            )
        ).toBeUndefined();
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse("bad"),
                now,
                successAdapter
            )
        ).toBeUndefined();
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse(credentialId),
                now,
                successAdapter
            )
        ).toBeUndefined();
    });

    it("consumes failed assertions and detects unknown credentials and atomic races", async () => {
        configureWebAuthn();
        const user = await createUser(`${USER_PREFIX}assertion-failure`, "password123");
        const credentialId = "credential_failure";
        insertCredential(user.id, credentialId, "[]", 0);
        const pendingToken = createPendingLogin(user.id, ["webauthn"]);
        const pending = getPendingLogin(pendingToken);
        if (!pending) {
            throw new Error("Could not create WebAuthn pending login");
        }
        const context: WebAuthnChallengeContext = {
            purpose: "login",
            pendingLoginId: pending.pendingLoginId,
            userId: user.id,
        };
        const now = new Date("2026-07-24T12:00:00.000Z");
        const unverifiedAt = new Date(now.getTime() + 1000);
        const consumedAt = new Date(now.getTime() + 2000);
        const counterRaceAt = new Date(now.getTime() + 3000);

        const unknownCredentialAdapter = fakeAdapter({
            generateAuthenticationOptions: async () =>
                authenticationOptions("unknown-credential"),
        });
        await createWebAuthnAuthenticationOptions(context, now, unknownCredentialAdapter);
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse("credential_unknown"),
                now,
                unknownCredentialAdapter
            )
        ).toBeUndefined();
        expect(
            database
                .prepare(
                    `SELECT COUNT(*) AS count
                     FROM auth_webauthn_challenges
                     WHERE user_id = ?`
                )
                .get(user.id)
        ).toEqual({ count: 0 });

        const throwingAdapter = fakeAdapter({
            generateAuthenticationOptions: async () => authenticationOptions("throwing"),
            verifyAuthenticationResponse: async () => {
                throw new Error("bad assertion");
            },
        });
        await createWebAuthnAuthenticationOptions(context, now, throwingAdapter);
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse(credentialId),
                now,
                throwingAdapter
            )
        ).toBeUndefined();

        const unverifiedAdapter = fakeAdapter({
            generateAuthenticationOptions: async () =>
                authenticationOptions("unverified"),
            verifyAuthenticationResponse: async () =>
                authenticationVerification(1, { verified: false }),
        });
        await createWebAuthnAuthenticationOptions(
            context,
            unverifiedAt,
            unverifiedAdapter
        );
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse(credentialId),
                unverifiedAt,
                unverifiedAdapter
            )
        ).toBeUndefined();

        const consumedAdapter = fakeAdapter({
            generateAuthenticationOptions: async () => authenticationOptions("consumed"),
            verifyAuthenticationResponse: async () => {
                database
                    .prepare(
                        `DELETE FROM auth_webauthn_challenges
                         WHERE user_id = ?`
                    )
                    .run(user.id);
                return authenticationVerification(1);
            },
        });
        await createWebAuthnAuthenticationOptions(context, consumedAt, consumedAdapter);
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse(credentialId),
                consumedAt,
                consumedAdapter
            )
        ).toBeUndefined();

        const counterRaceAdapter = fakeAdapter({
            generateAuthenticationOptions: async () =>
                authenticationOptions("counter-race"),
            verifyAuthenticationResponse: async () => {
                database
                    .prepare(
                        `UPDATE user_webauthn_credentials
                         SET counter = counter + 1
                         WHERE id = ?`
                    )
                    .run(credentialId);
                return authenticationVerification(2);
            },
        });
        await createWebAuthnAuthenticationOptions(
            context,
            counterRaceAt,
            counterRaceAdapter
        );
        expect(
            await verifyWebAuthnAuthentication(
                context,
                authenticationResponse(credentialId),
                counterRaceAt,
                counterRaceAdapter
            )
        ).toBeUndefined();
    });

    it("preserves a final factor and validates persisted WebAuthn configuration", async () => {
        const user = await createUser(`${USER_PREFIX}remove`, "password123");
        expect(didRemoveWebAuthnCredential(user.id, "bad")).toBe(false);
        insertCredential(user.id, "credential_one");
        insertCredential(user.id, "credential_two");
        expect(didRemoveWebAuthnCredential(user.id, "credential_unknown")).toBe(false);
        expect(didRemoveWebAuthnCredential(user.id, "credential_one")).toBe(true);
        expect(didRemoveWebAuthnCredential(user.id, "credential_two")).toBe(false);

        delete process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID;
        delete process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS;
        expect(() => validateWebAuthnConfig()).toThrow();
        configureWebAuthn();
        expect(validateWebAuthnConfig()).toBeUndefined();

        database
            .prepare("DELETE FROM user_webauthn_credentials WHERE user_id = ?")
            .run(user.id);
        delete process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID;
        delete process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS;
        expect(validateWebAuthnConfig()).toBeUndefined();
        process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID = "dashboard.example.com";
        expect(() => validateWebAuthnConfig()).toThrow();
    });
});
