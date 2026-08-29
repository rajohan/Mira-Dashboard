import { describe, expect, test } from "bun:test";

import { addMinutes } from "date-fns";
import * as v from "valibot";

import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import { users } from "../../../database/schema/users.ts";
import { validUserInsert } from "../../../database/validation/testSupport/securityRows.ts";
import { userInsertSchema } from "../../../database/validation/users.ts";
import { captureFailure } from "../../../test/support/promise.ts";
import { rateLimitBucketKey } from "../authenticationRateLimit.ts";
import type { AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import {
    AuthenticationUpstreamUnavailableError,
    AuthenticationWorkCapacityError,
    AuthenticationWorkTimeoutError,
    type AuthenticationVerificationWorkOptions,
    type AuthenticationWorkRuntimeService,
} from "../authenticationWorkGate.ts";
import {
    accountLifecycleInitialSessionId,
    accountLifecycleMetadata,
    accountLifecycleNow,
    accountLifecycleUserId,
    createAccountLifecycleHarness,
    enableAccountMfa,
} from "./testSupport/accountLifecycle.ts";
import {
    createWebAuthnAdapter,
    type VerifiedWebAuthnAuthentication,
    type VerifiedWebAuthnRegistration,
    type WebAuthnAdapter,
    type WebAuthnVerificationResult,
} from "./webauthn/adapter.ts";
import {
    createWebAuthnRelyingPartyConfiguration,
    type WebAuthnRelyingPartyConfiguration,
} from "./webauthn/relyingPartyConfiguration.ts";
import {
    ceremonyFixtureCredentialId,
    ceremonyFixtureOrigin,
    ceremonyFixturePublicKey,
    ceremonyFixtureRpId,
    createAuthenticationFixture,
    createRegistrationFixture,
} from "./webauthn/testSupport/ceremonyFixture.ts";

const oldRelyingPartyId = "old.dashboard.example";
const oldCredentialId = Buffer.alloc(32, 11).toString("base64url");
const secondOldCredentialId = Buffer.alloc(32, 12).toString("base64url");
const unknownCredentialId = Buffer.alloc(32, 29).toString("base64url");
const oldCredentialInternalId = "019fc968-1a9b-7778-8f1b-d5b863b0e7b4";
const secondOldCredentialInternalId = "019fc968-1a9b-777b-8f1b-d5b863b0e7b4";
const collisionOwnerId = "019fc968-1a9b-7779-8f1b-d5b863b0e7b4";
const collisionCredentialInternalId = "019fc968-1a9b-777a-8f1b-d5b863b0e7b4";

const relyingParty = createWebAuthnRelyingPartyConfiguration({
    allowedOrigins: [ceremonyFixtureOrigin],
    rpId: ceremonyFixtureRpId,
    rpName: "Mira Dashboard",
});

const acceptedWebAuthnBudget: AuthenticationWorkBudget = Object.freeze({
    consume: () => ({ accepted: true as const }),
});

interface AdapterControls {
    readonly authenticationInputs?: Parameters<
        WebAuthnAdapter["verifyAuthentication"]
    >[0][];
    readonly authenticationOptionsInputs?: Parameters<
        WebAuthnAdapter["generateAuthenticationOptions"]
    >[0][];
    readonly authenticationResult?: WebAuthnVerificationResult<VerifiedWebAuthnAuthentication>;
    readonly beforeAuthenticationVerification?: () => void;
    readonly registrationResult?: WebAuthnVerificationResult<VerifiedWebAuthnRegistration>;
}

function controlledAdapter(
    configuration: WebAuthnRelyingPartyConfiguration,
    controls: AdapterControls = {}
): WebAuthnAdapter {
    const optionAdapter = createWebAuthnAdapter(configuration);
    const adapter: WebAuthnAdapter = {
        generateAuthenticationOptions(input) {
            controls.authenticationOptionsInputs?.push(input);
            return optionAdapter.generateAuthenticationOptions(input);
        },
        generateRegistrationOptions: (input) =>
            optionAdapter.generateRegistrationOptions(input),
        verifyAuthentication(input) {
            controls.authenticationInputs?.push(input);
            controls.beforeAuthenticationVerification?.();
            return Promise.resolve(
                controls.authenticationResult ?? {
                    status: "verified",
                    verification: {
                        credentialBackedUp: true,
                        credentialDeviceType: "multiDevice",
                        credentialId: input.credential.id,
                        newCounter: input.credential.counter + 1,
                    },
                }
            );
        },
        verifyRegistration: () =>
            Promise.resolve(
                controls.registrationResult ?? {
                    status: "verified",
                    verification: {
                        credential: {
                            algorithm: -7,
                            counter: 0,
                            id: ceremonyFixtureCredentialId,
                            publicKey: ceremonyFixturePublicKey,
                            transports: ["usb"],
                        },
                        credentialBackedUp: true,
                        credentialDeviceType: "multiDevice",
                    },
                }
            ),
    };
    return Object.freeze(adapter);
}

const immediateWebAuthnRuntime: Pick<
    AuthenticationWorkRuntimeService,
    "runWebAuthnVerification"
> = Object.freeze({
    async runWebAuthnVerification<T>(
        work: (signal: AbortSignal) => Promise<T>,
        options: AuthenticationVerificationWorkOptions<T>
    ): Promise<T> {
        options.signal?.throwIfAborted();
        const decision = options.onBeforeStart?.() ?? { proceed: true as const };
        if (!decision.proceed) return decision.value;
        const signal = options.signal ?? new AbortController().signal;
        let value: T;
        try {
            value = await work(signal);
        } catch {
            options.signal?.throwIfAborted();
            const failure = new AuthenticationUpstreamUnavailableError({
                operation: "webauthn",
            });
            await options.onFailureBeforeRelease?.(failure);
            throw failure;
        }
        await options.onResultBeforeRelease?.(value);
        return value;
    },
});

function accountWebAuthnHarnessOptions(
    adapter: WebAuthnAdapter,
    overrides: {
        readonly webAuthnWorkBudget?: AuthenticationWorkBudget;
        readonly webAuthnWorkRuntime?: Pick<
            AuthenticationWorkRuntimeService,
            "runWebAuthnVerification"
        >;
    } = {}
) {
    return {
        webAuthnAdapter: adapter,
        webAuthnRelyingParty: relyingParty,
        webAuthnVerificationTimeoutMs: 5000,
        webAuthnWorkBudget: overrides.webAuthnWorkBudget ?? acceptedWebAuthnBudget,
        webAuthnWorkRuntime: overrides.webAuthnWorkRuntime ?? immediateWebAuthnRuntime,
    };
}

describe("MFA account WebAuthn lifecycle", () => {
    test("replaces registration challenges and enables the first credential atomically", async () => {
        const harness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(controlledAdapter(relyingParty))
        );
        try {
            const identity = {
                sessionId: accountLifecycleInitialSessionId,
                userId: accountLifecycleUserId,
            };
            const first = await harness.service.beginWebAuthnEnrollment(
                identity,
                accountLifecycleMetadata("webauthn-begin-first")
            );
            const firstChallenge = harness.repository.findSessionWebAuthnChallenge(
                identity.sessionId,
                "registration"
            );
            const replacement = await harness.service.beginWebAuthnEnrollment(
                identity,
                accountLifecycleMetadata("webauthn-begin-replacement")
            );
            const replacementChallenge = harness.repository.findSessionWebAuthnChallenge(
                identity.sessionId,
                "registration"
            );

            expect(first.status).toBe("created");
            expect(replacement.status).toBe("created");
            expect(firstChallenge?.id).not.toBe(replacementChallenge?.id);
            expect(replacement).toMatchObject({
                options: {
                    attestation: "none",
                    authenticatorSelection: {
                        authenticatorAttachment: "cross-platform",
                        residentKey: "discouraged",
                        userVerification: "required",
                    },
                    rp: { id: ceremonyFixtureRpId },
                },
                status: "created",
            });

            const confirmed = await harness.service.confirmWebAuthnEnrollment(
                identity,
                {
                    label: "Primary security key",
                    response: createRegistrationFixture(),
                },
                accountLifecycleMetadata("webauthn-confirm-first")
            );
            if (confirmed.status !== "confirmed" || !confirmed.enabledNow) {
                throw new Error(
                    `Expected first WebAuthn credential, received ${confirmed.status}`
                );
            }

            expect(confirmed.credential).toMatchObject({
                backedUp: true,
                deviceType: "multiDevice",
                label: "Primary security key",
                transports: ["usb"],
                usable: true,
            });
            expect(confirmed.recoveryCodes).toHaveLength(recoveryCodeCount);
            expect(confirmed.revokedSessions).toBe(1);
            expect(
                harness.repository.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                )
            ).toBeUndefined();
            expect(
                harness.repository.findWebAuthnCredential(
                    accountLifecycleUserId,
                    ceremonyFixtureCredentialId
                )
            ).toMatchObject({ rpId: ceremonyFixtureRpId, transportMask: 64 });
            expect(
                harness.repository.findSession(
                    accountLifecycleUserId,
                    confirmed.session.id
                )
            ).toMatchObject({
                authMethod: "webauthn",
                mfaVerifiedAt: accountLifecycleNow,
            });
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });

    test("filters RP-drift credentials from step-up while retaining cap and removal semantics", async () => {
        const authenticationOptionsInputs: Parameters<
            WebAuthnAdapter["generateAuthenticationOptions"]
        >[0][] = [];
        const harness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(
                controlledAdapter(relyingParty, { authenticationOptionsInputs })
            )
        );
        try {
            const enabled = await enableAccountMfa(harness);
            await harness.repository.withImmediateTransaction((unit) =>
                unit.insertWebAuthnCredential({
                    algorithm: -7,
                    backedUp: false,
                    counter: 0,
                    createdAt: accountLifecycleNow,
                    credentialId: oldCredentialId,
                    deviceType: "singleDevice",
                    id: oldCredentialInternalId,
                    label: "Old RP key",
                    lastUsedAt: null,
                    publicKey: Buffer.from(ceremonyFixturePublicKey),
                    rpId: oldRelyingPartyId,
                    transportMask: 64,
                    userId: accountLifecycleUserId,
                })
            );
            expect(
                await harness.service.removeTotpFactor(
                    enabled.identity,
                    { factorId: enabled.factorId },
                    accountLifecycleMetadata("protect-totp-from-old-rp")
                )
            ).toEqual({ status: "final-factor" });
            expect(harness.service.summary(enabled.identity)).toMatchObject({
                status: "found",
                summary: {
                    mfa: {
                        webAuthnCredentials: [
                            { id: oldCredentialInternalId, usable: false },
                        ],
                    },
                },
            });
            const enrollment = await harness.service.beginWebAuthnEnrollment(
                enabled.identity,
                accountLifecycleMetadata("webauthn-begin-additional")
            );
            expect(enrollment.status).toBe("created");
            const confirmed = await harness.service.confirmWebAuthnEnrollment(
                enabled.identity,
                { response: createRegistrationFixture() },
                accountLifecycleMetadata("webauthn-confirm-additional")
            );
            if (confirmed.status !== "confirmed" || confirmed.enabledNow) {
                throw new Error("Expected additional WebAuthn credential");
            }
            expect(
                await harness.service.beginWebAuthnStepUp(
                    enabled.identity,
                    accountLifecycleMetadata("webauthn-begin-step-up")
                )
            ).toMatchObject({ status: "created" });
            expect(authenticationOptionsInputs.at(-1)?.allowCredentials).toEqual([
                { id: ceremonyFixtureCredentialId },
            ]);

            const verified = await harness.service.stepUpWebAuthn(
                enabled.identity,
                {
                    response: await createAuthenticationFixture({ counter: 1 }),
                },
                accountLifecycleMetadata("webauthn-step-up")
            );
            if (verified.status !== "verified") {
                throw new Error(`Expected WebAuthn step-up, received ${verified.status}`);
            }
            expect(
                harness.repository.findWebAuthnCredential(
                    accountLifecycleUserId,
                    ceremonyFixtureCredentialId
                )
            ).toMatchObject({ counter: 1, lastUsedAt: accountLifecycleNow });
            expect(
                await harness.service.removeTotpFactor(
                    {
                        sessionId: verified.session.id,
                        userId: accountLifecycleUserId,
                    },
                    { factorId: enabled.factorId },
                    accountLifecycleMetadata("remove-totp-with-current-rp")
                )
            ).toMatchObject({ removed: true, status: "removed" });
            expect(
                await harness.service.removeWebAuthnCredential(
                    {
                        sessionId: verified.session.id,
                        userId: accountLifecycleUserId,
                    },
                    { credentialId: confirmed.credential.id },
                    accountLifecycleMetadata("protect-current-from-old-rp")
                )
            ).toEqual({ status: "final-factor" });
            expect(
                await harness.service.removeWebAuthnCredential(
                    {
                        sessionId: verified.session.id,
                        userId: accountLifecycleUserId,
                    },
                    { credentialId: oldCredentialInternalId },
                    accountLifecycleMetadata("remove-old-rp")
                )
            ).toMatchObject({ removed: true, status: "removed" });
        } finally {
            harness.close();
        }
    });

    test("allows drifted-only inventory cleanup down to one raw possession factor", async () => {
        const harness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(controlledAdapter(relyingParty))
        );
        try {
            const enabled = await enableAccountMfa(harness);
            await harness.repository.withImmediateTransaction((unit) => {
                unit.insertWebAuthnCredential({
                    algorithm: -7,
                    backedUp: false,
                    counter: 0,
                    createdAt: accountLifecycleNow,
                    credentialId: oldCredentialId,
                    deviceType: "singleDevice",
                    id: oldCredentialInternalId,
                    label: "Old RP key one",
                    lastUsedAt: null,
                    publicKey: Buffer.from(ceremonyFixturePublicKey),
                    rpId: oldRelyingPartyId,
                    transportMask: 64,
                    userId: accountLifecycleUserId,
                });
                unit.insertWebAuthnCredential({
                    algorithm: -7,
                    backedUp: false,
                    counter: 0,
                    createdAt: accountLifecycleNow,
                    credentialId: secondOldCredentialId,
                    deviceType: "singleDevice",
                    id: secondOldCredentialInternalId,
                    label: "Old RP key two",
                    lastUsedAt: null,
                    publicKey: Buffer.from(ceremonyFixturePublicKey),
                    rpId: oldRelyingPartyId,
                    transportMask: 64,
                    userId: accountLifecycleUserId,
                });
                unit.deleteTotpFactor(accountLifecycleUserId, enabled.factorId);
            });

            expect(
                await harness.service.removeWebAuthnCredential(
                    enabled.identity,
                    { credentialId: oldCredentialInternalId },
                    accountLifecycleMetadata("remove-first-drifted-only-factor")
                )
            ).toMatchObject({ removed: true, status: "removed" });
            expect(
                await harness.service.removeWebAuthnCredential(
                    enabled.identity,
                    { credentialId: secondOldCredentialInternalId },
                    accountLifecycleMetadata("protect-last-drifted-only-factor")
                )
            ).toEqual({ status: "final-factor" });
        } finally {
            harness.close();
        }
    });

    test("runs unknown ids through fallback verification and consumes the challenge as invalid", async () => {
        const authenticationInputs: Parameters<
            WebAuthnAdapter["verifyAuthentication"]
        >[0][] = [];
        const harness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(
                controlledAdapter(relyingParty, { authenticationInputs })
            )
        );
        try {
            const enabled = await enableAccountMfa(harness);
            await harness.service.beginWebAuthnEnrollment(
                enabled.identity,
                accountLifecycleMetadata("begin-known-credential")
            );
            const confirmed = await harness.service.confirmWebAuthnEnrollment(
                enabled.identity,
                { response: createRegistrationFixture() },
                accountLifecycleMetadata("confirm-known-credential")
            );
            if (confirmed.status !== "confirmed") {
                throw new Error("Expected known WebAuthn credential");
            }
            await harness.service.beginWebAuthnStepUp(
                enabled.identity,
                accountLifecycleMetadata("begin-unknown-assertion")
            );
            const input = {
                response: await createAuthenticationFixture({
                    counter: 1,
                    id: unknownCredentialId,
                }),
            };
            const result = await harness.service.stepUpWebAuthn(
                enabled.identity,
                input,
                accountLifecycleMetadata("unknown-assertion")
            );

            expect(result).toEqual({ status: "invalid-proof" });
            expect(authenticationInputs).toHaveLength(1);
            expect(authenticationInputs[0]?.credential).toMatchObject({
                id: unknownCredentialId,
                publicKey: ceremonyFixturePublicKey,
                rpId: ceremonyFixtureRpId,
            });
            expect(
                harness.repository.findSessionWebAuthnChallenge(
                    enabled.identity.sessionId,
                    "step-up"
                )
            ).toBeUndefined();
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-mfa", accountLifecycleUserId)
                )
            ).toMatchObject({ failureCount: 1 });
            expect(
                await harness.service.stepUpWebAuthn(
                    enabled.identity,
                    input,
                    accountLifecycleMetadata("unknown-assertion-replay")
                )
            ).toEqual({ status: "state-changed" });
        } finally {
            harness.close();
        }
    });

    test("commits challenge consumption when a verified registration collides globally", async () => {
        const harness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(controlledAdapter(relyingParty))
        );
        try {
            harness.database.orm
                .insert(users)
                .values(
                    v.parse(userInsertSchema, {
                        ...validUserInsert,
                        email: "collision-owner@example.com",
                        id: collisionOwnerId,
                        username: "collision-owner",
                    })
                )
                .run();
            await harness.repository.withImmediateTransaction((unit) =>
                unit.insertWebAuthnCredential({
                    algorithm: -7,
                    backedUp: true,
                    counter: 0,
                    createdAt: accountLifecycleNow,
                    credentialId: ceremonyFixtureCredentialId,
                    deviceType: "multiDevice",
                    id: collisionCredentialInternalId,
                    label: "Other owner credential",
                    lastUsedAt: null,
                    publicKey: Buffer.from(ceremonyFixturePublicKey),
                    rpId: ceremonyFixtureRpId,
                    transportMask: 64,
                    userId: collisionOwnerId,
                })
            );
            const identity = {
                sessionId: accountLifecycleInitialSessionId,
                userId: accountLifecycleUserId,
            };
            await harness.service.beginWebAuthnEnrollment(
                identity,
                accountLifecycleMetadata("begin-collision")
            );
            const response = { response: createRegistrationFixture() };
            const collision = await harness.service.confirmWebAuthnEnrollment(
                identity,
                response,
                accountLifecycleMetadata("confirm-collision")
            );

            expect(collision).toEqual({ status: "invalid-proof" });
            expect(
                harness.repository.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                )
            ).toBeUndefined();
            expect(
                harness.repository.countWebAuthnCredentials(accountLifecycleUserId)
            ).toBe(0);
            expect(
                harness.repository.findUserById(accountLifecycleUserId)?.mfaEnabledAt
            ).toBeNull();
            expect(
                await harness.service.confirmWebAuthnEnrollment(
                    identity,
                    response,
                    accountLifecycleMetadata("replay-collision")
                )
            ).toEqual({ status: "state-changed" });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.mfa.webauthn.enrollment.confirm'
                          AND outcome = 'denied'
                    `)
                    .get()
            ).toEqual({ count: 1 });
        } finally {
            harness.close();
        }
    });

    test("keeps challenges for capacity and budget rejection but consumes timeout", async () => {
        const capacityRuntime = Object.freeze({
            runWebAuthnVerification: () =>
                Promise.reject(
                    new AuthenticationWorkCapacityError({
                        operation: "webauthn",
                    })
                ),
        }) as Pick<AuthenticationWorkRuntimeService, "runWebAuthnVerification">;
        const timeoutRuntime = Object.freeze({
            async runWebAuthnVerification<T>(
                _work: (signal: AbortSignal) => Promise<T>,
                options: AuthenticationVerificationWorkOptions<T>
            ): Promise<T> {
                const decision = options.onBeforeStart?.() ?? {
                    proceed: true as const,
                };
                if (!decision.proceed) return decision.value;
                const failure = new AuthenticationWorkTimeoutError({
                    operation: "webauthn",
                    timeoutMs: options.timeoutMs,
                });
                await options.onFailureBeforeRelease?.(failure);
                throw failure;
            },
        });

        for (const testCase of [
            {
                expectedRetry: 1,
                options: { webAuthnWorkRuntime: capacityRuntime },
            },
            {
                expectedRetry: 17,
                options: {
                    webAuthnWorkBudget: Object.freeze({
                        consume: () => ({
                            accepted: false as const,
                            retryAfterSeconds: 17,
                        }),
                    }),
                },
            },
        ] as const) {
            const harness = await createAccountLifecycleHarness(
                accountWebAuthnHarnessOptions(
                    controlledAdapter(relyingParty),
                    testCase.options
                )
            );
            try {
                const identity = {
                    sessionId: accountLifecycleInitialSessionId,
                    userId: accountLifecycleUserId,
                };
                await harness.service.beginWebAuthnEnrollment(
                    identity,
                    accountLifecycleMetadata("begin-unadmitted")
                );
                expect(
                    await harness.service.confirmWebAuthnEnrollment(
                        identity,
                        { response: createRegistrationFixture() },
                        accountLifecycleMetadata("confirm-unadmitted")
                    )
                ).toEqual({
                    retryAfterSeconds: testCase.expectedRetry,
                    status: "rate-limited",
                });
                expect(
                    harness.repository.findSessionWebAuthnChallenge(
                        identity.sessionId,
                        "registration"
                    )
                ).toBeDefined();
            } finally {
                harness.close();
            }
        }

        const timeoutHarness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(controlledAdapter(relyingParty), {
                webAuthnWorkRuntime: timeoutRuntime,
            })
        );
        try {
            const identity = {
                sessionId: accountLifecycleInitialSessionId,
                userId: accountLifecycleUserId,
            };
            await timeoutHarness.service.beginWebAuthnEnrollment(
                identity,
                accountLifecycleMetadata("begin-timeout")
            );
            expect(
                await timeoutHarness.service.confirmWebAuthnEnrollment(
                    identity,
                    { response: createRegistrationFixture() },
                    accountLifecycleMetadata("confirm-timeout")
                )
            ).toEqual({ status: "service-unavailable" });
            expect(
                timeoutHarness.repository.findSessionWebAuthnChallenge(
                    identity.sessionId,
                    "registration"
                )
            ).toBeUndefined();
            expect(
                timeoutHarness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-mfa", accountLifecycleUserId)
                )
            ).toBeUndefined();
        } finally {
            timeoutHarness.close();
        }
    });

    test("consumes active cancellation without a failure count", async () => {
        let cancelActiveWork = false;
        const cancellationRuntime = Object.freeze({
            async runWebAuthnVerification<T>(
                work: (signal: AbortSignal) => Promise<T>,
                options: AuthenticationVerificationWorkOptions<T>
            ): Promise<T> {
                const decision = options.onBeforeStart?.() ?? {
                    proceed: true as const,
                };
                if (!decision.proceed) return decision.value;
                const value = await work(new AbortController().signal);
                if (!cancelActiveWork) {
                    await options.onResultBeforeRelease?.(value);
                    return value;
                }
                await options.onCancellationBeforeRelease?.();
                throw new DOMException("Test request cancelled", "AbortError");
            },
        });
        const harness = await createAccountLifecycleHarness(
            accountWebAuthnHarnessOptions(controlledAdapter(relyingParty), {
                webAuthnWorkRuntime: cancellationRuntime,
            })
        );
        try {
            const enabled = await enableAccountMfa(harness);
            await harness.service.beginWebAuthnEnrollment(
                enabled.identity,
                accountLifecycleMetadata("begin-cancel-credential")
            );
            expect(
                await harness.service.confirmWebAuthnEnrollment(
                    enabled.identity,
                    { response: createRegistrationFixture() },
                    accountLifecycleMetadata("confirm-cancel-credential")
                )
            ).toMatchObject({ status: "confirmed" });
            await harness.service.beginWebAuthnStepUp(
                enabled.identity,
                accountLifecycleMetadata("begin-cancel-step-up")
            );
            cancelActiveWork = true;
            const response = await createAuthenticationFixture({ counter: 1 });

            const failure = await captureFailure(() =>
                harness.service.stepUpWebAuthn(
                    enabled.identity,
                    { response },
                    accountLifecycleMetadata("cancel-step-up")
                )
            );

            expect(failure).toBeInstanceOf(DOMException);
            expect((failure as DOMException).name).toBe("AbortError");
            expect(
                harness.repository.findSessionWebAuthnChallenge(
                    enabled.identity.sessionId,
                    "step-up"
                )
            ).toBeUndefined();
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-mfa", accountLifecycleUserId)
                )
            ).toBeUndefined();
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.mfa.step-up'
                          AND outcome = 'cancelled'
                    `)
                    .get()
            ).toEqual({ count: 1 });
        } finally {
            harness.close();
        }
    });

    test("consumes a challenge but rejects verification completed after expiry", async () => {
        let clock = accountLifecycleNow;
        const adapter = controlledAdapter(relyingParty, {
            beforeAuthenticationVerification: () => {
                clock = addMinutes(accountLifecycleNow, 2);
            },
        });
        const harness = await createAccountLifecycleHarness({
            ...accountWebAuthnHarnessOptions(adapter),
            now: () => clock,
        });
        try {
            const enabled = await enableAccountMfa(harness);
            await harness.service.beginWebAuthnEnrollment(
                enabled.identity,
                accountLifecycleMetadata("begin-expiry-credential")
            );
            expect(
                await harness.service.confirmWebAuthnEnrollment(
                    enabled.identity,
                    { response: createRegistrationFixture() },
                    accountLifecycleMetadata("confirm-expiry-credential")
                )
            ).toMatchObject({ status: "confirmed" });
            await harness.service.beginWebAuthnStepUp(
                enabled.identity,
                accountLifecycleMetadata("begin-expiring-step-up")
            );

            expect(
                await harness.service.stepUpWebAuthn(
                    enabled.identity,
                    {
                        response: await createAuthenticationFixture({ counter: 1 }),
                    },
                    accountLifecycleMetadata("complete-expired-step-up")
                )
            ).toEqual({ status: "service-unavailable" });
            expect(
                harness.repository.findSessionWebAuthnChallenge(
                    enabled.identity.sessionId,
                    "step-up"
                )
            ).toBeUndefined();
            expect(
                harness.repository.findWebAuthnCredential(
                    accountLifecycleUserId,
                    ceremonyFixtureCredentialId
                )
            ).toMatchObject({ counter: 0, lastUsedAt: null });
        } finally {
            harness.close();
        }
    });
});
