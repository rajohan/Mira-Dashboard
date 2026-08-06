import { describe, expect, test } from "bun:test";

import { addMinutes } from "date-fns";
import * as v from "valibot";

import {
    webAuthnAuthenticationOptionsSchema,
    webAuthnCeremonyTimeoutMs,
} from "../../../../contracts/webauthn.ts";
import { rateLimitBucketKey } from "../authenticationRateLimit.ts";
import {
    AuthenticationUpstreamUnavailableError,
    type AuthenticationVerificationWorkOptions,
    AuthenticationWorkCapacityError,
    AuthenticationWorkTimeoutError,
    type AuthenticationWorkRuntimeService,
} from "../authenticationWorkGate.ts";
import type { MfaLoginWebAuthnDependencies } from "./loginLifecycleTypes.ts";
import {
    beginPasswordMfaLogin,
    createMfaLoginBarrier,
    createMfaLoginHarness,
    mfaLoginClientSourceId,
    mfaLoginMetadata,
    mfaLoginNow,
    mfaLoginRecoveryCode,
    mfaLoginSessionCount,
    mfaLoginTotpFactorId,
    mfaLoginUserId,
} from "./testSupport/loginLifecycle.ts";
import {
    createWebAuthnAdapter,
    type WebAuthnAdapter,
    type WebAuthnVerificationResult,
    type VerifiedWebAuthnAuthentication,
} from "./webauthn/adapter.ts";
import { createWebAuthnRelyingPartyConfiguration } from "./webauthn/relyingPartyConfiguration.ts";
import {
    ceremonyFixtureChallenge,
    ceremonyFixtureCredentialId,
    ceremonyFixtureOrigin,
    ceremonyFixturePublicKey,
    ceremonyFixtureRpId,
    createAuthenticationFixture,
} from "./webauthn/testSupport/ceremonyFixture.ts";

type WebAuthnWorkRuntime = Pick<
    AuthenticationWorkRuntimeService,
    "runWebAuthnVerification"
>;

const relyingParty = createWebAuthnRelyingPartyConfiguration({
    allowedOrigins: [ceremonyFixtureOrigin],
    rpId: ceremonyFixtureRpId,
    rpName: "Mira Dashboard",
});
const authenticationOptions = v.parse(webAuthnAuthenticationOptionsSchema, {
    allowCredentials: [
        {
            id: ceremonyFixtureCredentialId,
            transports: ["usb"],
            type: "public-key",
        },
    ],
    challenge: ceremonyFixtureChallenge,
    rpId: ceremonyFixtureRpId,
    timeout: webAuthnCeremonyTimeoutMs,
    userVerification: "required",
});
const oldRpCredentialId = Buffer.alloc(32, 47).toString("base64url");
const oldRpCredentialInternalId = "019fc968-1a9b-7778-8f1b-d5b863b0e7b4";

function inertWorkRuntime(): WebAuthnWorkRuntime {
    return Object.freeze({
        async runWebAuthnVerification<T>(
            work: (signal: AbortSignal) => Promise<T>,
            options: AuthenticationVerificationWorkOptions<T>
        ): Promise<T> {
            options.signal?.throwIfAborted();
            const decision = options.onBeforeStart?.() ?? { proceed: true as const };
            if (!decision.proceed) return decision.value;
            const signal = new AbortController().signal;
            try {
                const value = await work(signal);
                options.onResultBeforeRelease?.(value);
                return value;
            } catch {
                const failure = new AuthenticationUpstreamUnavailableError({
                    operation: "webauthn",
                });
                options.onFailureBeforeRelease?.(failure);
                throw failure;
            }
        },
    });
}

function failingWorkRuntime(
    failure: "capacity" | "timeout" | "upstream"
): WebAuthnWorkRuntime {
    return Object.freeze({
        runWebAuthnVerification<T>(
            _work: (signal: AbortSignal) => Promise<T>,
            options: AuthenticationVerificationWorkOptions<T>
        ): Promise<T> {
            if (failure === "capacity") {
                return Promise.reject(
                    new AuthenticationWorkCapacityError({
                        operation: "webauthn",
                    })
                );
            }
            const decision = options.onBeforeStart?.() ?? { proceed: true as const };
            if (!decision.proceed) return Promise.resolve(decision.value);
            const error =
                failure === "timeout"
                    ? new AuthenticationWorkTimeoutError({
                          operation: "webauthn",
                          timeoutMs: options.timeoutMs,
                      })
                    : new AuthenticationUpstreamUnavailableError({
                          operation: "webauthn",
                      });
            options.onFailureBeforeRelease?.(error);
            return Promise.reject(error);
        },
    });
}

function cancellationWorkRuntime(): WebAuthnWorkRuntime {
    return Object.freeze({
        runWebAuthnVerification<T>(
            _work: (signal: AbortSignal) => Promise<T>,
            options: AuthenticationVerificationWorkOptions<T>
        ): Promise<T> {
            const decision = options.onBeforeStart?.() ?? { proceed: true as const };
            if (!decision.proceed) return Promise.resolve(decision.value);
            options.onCancellationBeforeRelease?.();
            return Promise.reject(
                new DOMException("WebAuthn request aborted", "AbortError")
            );
        },
    });
}

function queuedTimeoutWorkRuntime(): WebAuthnWorkRuntime {
    return Object.freeze({
        runWebAuthnVerification<T>(
            _work: (signal: AbortSignal) => Promise<T>,
            options: AuthenticationVerificationWorkOptions<T>
        ): Promise<T> {
            const failure = new AuthenticationWorkTimeoutError({
                operation: "webauthn",
                timeoutMs: options.timeoutMs,
            });
            options.onFailureBeforeRelease?.(failure);
            return Promise.reject(failure);
        },
    });
}

function fixedChallengeAdapter(
    options: {
        readonly beforeVerification?: () => Promise<void> | void;
        readonly verification?: WebAuthnVerificationResult<VerifiedWebAuthnAuthentication>;
    } = {}
): WebAuthnAdapter {
    const production = createWebAuthnAdapter(relyingParty);
    return Object.freeze({
        generateAuthenticationOptions: () =>
            Promise.resolve({
                options: authenticationOptions,
                status: "generated" as const,
            }),
        generateRegistrationOptions: (
            input: Parameters<WebAuthnAdapter["generateRegistrationOptions"]>[0]
        ) => production.generateRegistrationOptions(input),
        async verifyAuthentication(
            input: Parameters<WebAuthnAdapter["verifyAuthentication"]>[0]
        ) {
            await options.beforeVerification?.();
            return options.verification ?? (await production.verifyAuthentication(input));
        },
        verifyRegistration: (
            input: Parameters<WebAuthnAdapter["verifyRegistration"]>[0]
        ) => production.verifyRegistration(input),
    });
}

function webAuthnDependencies(
    options: {
        readonly adapter?: WebAuthnAdapter;
        readonly workBudget?: MfaLoginWebAuthnDependencies["workBudget"];
        readonly workRuntime?: WebAuthnWorkRuntime;
    } = {}
): MfaLoginWebAuthnDependencies {
    return {
        adapter: options.adapter ?? fixedChallengeAdapter(),
        relyingParty,
        workBudget:
            options.workBudget ??
            Object.freeze({ consume: () => ({ accepted: true as const }) }),
        workRuntime: options.workRuntime ?? inertWorkRuntime(),
    };
}

async function beginWebAuthnCeremony(
    harness: Awaited<ReturnType<typeof createMfaLoginHarness>>,
    requestId: string
) {
    const pending = await beginPasswordMfaLogin(harness, `${requestId}-password`);
    const begun = await harness.service.beginWebAuthnLogin(
        pending.credential,
        mfaLoginMetadata(`${requestId}-begin`)
    );
    if (begun.status !== "created") {
        throw new Error(`Expected WebAuthn challenge, received ${begun.status}`);
    }
    return { begun, pending };
}

function auditCount(
    harness: Awaited<ReturnType<typeof createMfaLoginHarness>>,
    outcome: "cancelled" | "denied" | "failed" | "succeeded"
): number {
    return (
        harness.database.sqlite
            .query<{ count: number }, [string]>(`
                SELECT count(*) AS count
                FROM audit_events
                WHERE action = 'auth.login.mfa' AND outcome = ?
            `)
            .get(outcome)?.count ?? -1
    );
}

describe("MFA WebAuthn login lifecycle", () => {
    test("does not advertise credentials from a different relying party", async () => {
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies(),
        });
        try {
            harness.database.sqlite.run(
                "UPDATE user_webauthn_credentials SET rp_id = 'legacy.example'"
            );
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-webauthn-rp-drift"
            );

            expect(pending.pendingLogin.methods).toEqual(["recovery", "totp"]);
            expect(
                await harness.service.beginWebAuthnLogin(
                    pending.credential,
                    mfaLoginMetadata("request-webauthn-rp-drift-begin")
                )
            ).toEqual({ status: "not-available" });
        } finally {
            harness.close();
        }
    });

    test("recovers a WebAuthn-only account after relying-party drift", async () => {
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies(),
        });
        try {
            harness.database.sqlite.run(
                "UPDATE user_webauthn_credentials SET rp_id = 'legacy.example'"
            );
            harness.repository.withImmediateTransaction((unit) => {
                unit.deleteTotpFactor(mfaLoginUserId, mfaLoginTotpFactorId);
            });

            const pending = await beginPasswordMfaLogin(
                harness,
                "request-webauthn-rp-drift-recovery"
            );
            expect(pending.pendingLogin.methods).toEqual(["recovery"]);

            const completed = await harness.service.completeRecoveryLogin(
                pending.credential,
                { code: mfaLoginRecoveryCode },
                mfaLoginMetadata("request-webauthn-rp-drift-recovery-complete")
            );
            if (completed.status !== "authenticated") {
                throw new Error(
                    `Expected recovery completion, received ${completed.status}`
                );
            }
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(
                harness.repository.findSession(mfaLoginUserId, completed.session.id)
            ).toMatchObject({ authMethod: "recovery" });
            expect(mfaLoginSessionCount(harness)).toBe(1);
        } finally {
            harness.close();
        }
    });

    test("generates outside SQLite and atomically replaces a compatible pending challenge", async () => {
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies(),
        });
        try {
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-webauthn-pending"
            );
            expect(pending.pendingLogin.methods).toEqual([
                "recovery",
                "totp",
                "webauthn",
            ]);

            const first = await harness.service.beginWebAuthnLogin(
                pending.credential,
                mfaLoginMetadata("request-webauthn-begin-first")
            );
            const firstRecord = harness.repository.findPendingLoginWebAuthnChallenge(
                pending.credential.prefix
            );
            const second = await harness.service.beginWebAuthnLogin(
                pending.credential,
                mfaLoginMetadata("request-webauthn-begin-second")
            );
            const secondRecord = harness.repository.findPendingLoginWebAuthnChallenge(
                pending.credential.prefix
            );

            expect(first).toMatchObject({ status: "created" });
            expect(second).toMatchObject({ status: "created" });
            expect(firstRecord).toMatchObject({
                authenticationVersion: 1,
                configFingerprint: relyingParty.fingerprint,
                pendingLoginId: pending.credential.prefix,
                purpose: "login",
            });
            expect(secondRecord?.id).not.toBe(firstRecord?.id);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_challenges"
                    )
                    .get()
            ).toEqual({ count: 1 });
            expect(harness.webAuthnGenerationTransactionStates).toEqual([false, false]);
        } finally {
            harness.close();
        }
    });

    test("atomically consumes pending and challenge while accepting zero-counter credentials", async () => {
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies(),
        });
        try {
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-success"
            );
            const result = await harness.service.completeWebAuthnLogin(
                pending.credential,
                { response: await createAuthenticationFixture({ counter: 0 }) },
                mfaLoginMetadata("request-webauthn-complete")
            );

            expect(result.status).toBe("authenticated");
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(
                harness.repository.findWebAuthnCredential(
                    mfaLoginUserId,
                    ceremonyFixtureCredentialId
                )
            ).toMatchObject({
                backedUp: true,
                counter: 0,
                deviceType: "multiDevice",
                lastUsedAt: mfaLoginNow,
            });
            if (result.status === "authenticated") {
                expect(
                    harness.repository.findSession(mfaLoginUserId, result.session.id)
                ).toMatchObject({ authMethod: "webauthn" });
            }
            expect(mfaLoginSessionCount(harness)).toBe(1);
            expect(harness.webAuthnVerificationTransactionStates).toEqual([false]);
            expect(auditCount(harness, "succeeded")).toBe(1);
        } finally {
            harness.close();
        }
    });

    test("allows exactly one concurrent assertion to consume the ceremony", async () => {
        const barrier = createMfaLoginBarrier(2);
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies({
                adapter: fixedChallengeAdapter({
                    beforeVerification: () => barrier.wait(),
                }),
            }),
        });
        try {
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-double-submit"
            );
            const responses = await Promise.all([
                createAuthenticationFixture({ counter: 0 }),
                createAuthenticationFixture({ counter: 0 }),
            ]);
            const results = await Promise.all(
                responses.map((response, index) =>
                    harness.service.completeWebAuthnLogin(
                        pending.credential,
                        { response },
                        mfaLoginMetadata(`request-webauthn-double-submit-${index}`)
                    )
                )
            );

            expect(results.map(({ status }) => status).toSorted()).toEqual([
                "authenticated",
                "state-changed",
            ]);
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(mfaLoginSessionCount(harness)).toBe(1);
            expect(auditCount(harness, "succeeded")).toBe(1);
        } finally {
            harness.close();
        }
    });

    test("commits challenge consumption when credential CAS loses", async () => {
        const harnessState: {
            value?: Awaited<ReturnType<typeof createMfaLoginHarness>>;
        } = {};
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies({
                adapter: fixedChallengeAdapter({
                    beforeVerification: () => {
                        const current = harnessState.value;
                        if (current === undefined) {
                            throw new Error("WebAuthn CAS-race harness is unavailable");
                        }
                        current.database.sqlite.run(
                            "UPDATE user_webauthn_credentials SET counter = 1 WHERE credential_id = ?",
                            [ceremonyFixtureCredentialId]
                        );
                    },
                }),
            }),
        });
        harnessState.value = harness;
        try {
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-cas-race"
            );
            const result = await harness.service.completeWebAuthnLogin(
                pending.credential,
                { response: await createAuthenticationFixture({ counter: 0 }) },
                mfaLoginMetadata("request-webauthn-cas-race-complete")
            );

            expect(result).toEqual({ status: "state-changed" });
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toMatchObject({ attemptCount: 0 });
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(
                harness.repository.findWebAuthnCredential(
                    mfaLoginUserId,
                    ceremonyFixtureCredentialId
                )
            ).toMatchObject({ counter: 1, lastUsedAt: null });
            expect(mfaLoginSessionCount(harness)).toBe(0);
        } finally {
            harness.close();
        }
    });

    test("makes unknown credential ids and invalid assertions externally identical", async () => {
        const invalidKnownResponse = await createAuthenticationFixture({ counter: 0 });
        invalidKnownResponse.response.signature =
            invalidKnownResponse.response.signature.startsWith("A")
                ? `B${invalidKnownResponse.response.signature.slice(1)}`
                : `A${invalidKnownResponse.response.signature.slice(1)}`;
        const unknownCredentialId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
        const unknownResponse = await createAuthenticationFixture({
            counter: 0,
            id: unknownCredentialId,
            rawId: unknownCredentialId,
        });

        for (const [name, response] of [
            ["known-invalid", invalidKnownResponse],
            ["unknown", unknownResponse],
        ] as const) {
            const harness = await createMfaLoginHarness({
                webAuthn: webAuthnDependencies(),
            });
            try {
                const { pending } = await beginWebAuthnCeremony(
                    harness,
                    `request-webauthn-${name}`
                );
                const result = await harness.service.completeWebAuthnLogin(
                    pending.credential,
                    { response },
                    mfaLoginMetadata(`request-webauthn-${name}-complete`)
                );

                expect(result).toEqual({ status: "invalid-proof" });
                expect(
                    harness.repository.findPendingLoginWebAuthnChallenge(
                        pending.credential.prefix
                    )
                ).toBeUndefined();
                expect(
                    harness.repository.findPendingLogin(pending.credential.prefix)
                        ?.attemptCount
                ).toBe(1);
                expect(
                    harness.repository.findRateLimitBucket(
                        rateLimitBucketKey("login-mfa-source", mfaLoginClientSourceId)
                    )
                ).toMatchObject({ failureCount: 1 });
                expect(auditCount(harness, "denied")).toBe(1);
                expect(harness.webAuthnVerificationTransactionStates).toEqual([false]);
                expect(mfaLoginSessionCount(harness)).toBe(0);
            } finally {
                harness.close();
            }
        }
    });

    test("treats a submitted old-RP credential id as unknown", async () => {
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies(),
        });
        try {
            harness.repository.withImmediateTransaction((unit) =>
                unit.insertWebAuthnCredential({
                    algorithm: -7,
                    backedUp: true,
                    counter: 0,
                    createdAt: mfaLoginNow,
                    credentialId: oldRpCredentialId,
                    deviceType: "multiDevice",
                    id: oldRpCredentialInternalId,
                    label: "Old RP credential",
                    lastUsedAt: null,
                    publicKey: Buffer.from(ceremonyFixturePublicKey),
                    rpId: "old.dashboard.example",
                    transportMask: 64,
                    userId: mfaLoginUserId,
                })
            );
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-old-rp-id"
            );
            const result = await harness.service.completeWebAuthnLogin(
                pending.credential,
                {
                    response: await createAuthenticationFixture({
                        counter: 0,
                        id: oldRpCredentialId,
                        rawId: oldRpCredentialId,
                    }),
                },
                mfaLoginMetadata("request-webauthn-old-rp-id-complete")
            );

            expect(result).toEqual({ status: "invalid-proof" });
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toMatchObject({ attemptCount: 1 });
            expect(harness.webAuthnVerificationTransactionStates).toEqual([false]);
            expect(auditCount(harness, "denied")).toBe(1);
            expect(mfaLoginSessionCount(harness)).toBe(0);
        } finally {
            harness.close();
        }
    });

    test("consumes the challenge when another gate establishes cooldown during verification", async () => {
        const harnessState: {
            value?: Awaited<ReturnType<typeof createMfaLoginHarness>>;
        } = {};
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies({
                adapter: fixedChallengeAdapter({
                    beforeVerification: () => {
                        const current = harnessState.value;
                        if (current === undefined) {
                            throw new Error(
                                "WebAuthn cooldown-race harness is unavailable"
                            );
                        }
                        const bucketKey = rateLimitBucketKey(
                            "login-mfa-source",
                            mfaLoginClientSourceId
                        );
                        current.repository.withImmediateTransaction((unit) => {
                            unit.upsertRateLimitBucket({
                                blockedUntil: addMinutes(mfaLoginNow, 1),
                                bucketKey,
                                failureCount: 3,
                                firstFailedAt: mfaLoginNow,
                                kind: "login-mfa-source",
                                updatedAt: mfaLoginNow,
                            });
                        });
                    },
                    verification: { status: "invalid-proof" },
                }),
            }),
        });
        harnessState.value = harness;
        try {
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-cooldown-race"
            );
            const result = await harness.service.completeWebAuthnLogin(
                pending.credential,
                { response: await createAuthenticationFixture({ counter: 0 }) },
                mfaLoginMetadata("request-webauthn-cooldown-race-complete")
            );

            expect(result).toMatchObject({ status: "rate-limited" });
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toMatchObject({ attemptCount: 0 });
            expect(auditCount(harness, "denied")).toBe(0);
        } finally {
            harness.close();
        }
    });

    test("consumes timeout and upstream failures without counting invalid proof", async () => {
        for (const failure of ["timeout", "upstream"] as const) {
            const harness = await createMfaLoginHarness({
                webAuthn: webAuthnDependencies({
                    workRuntime: failingWorkRuntime(failure),
                }),
            });
            try {
                const { pending } = await beginWebAuthnCeremony(
                    harness,
                    `request-webauthn-${failure}`
                );
                const result = await harness.service.completeWebAuthnLogin(
                    pending.credential,
                    { response: await createAuthenticationFixture({ counter: 0 }) },
                    mfaLoginMetadata(`request-webauthn-${failure}-complete`)
                );

                expect(result).toEqual({ status: "service-unavailable" });
                expect(
                    harness.repository.findPendingLoginWebAuthnChallenge(
                        pending.credential.prefix
                    )
                ).toBeUndefined();
                expect(
                    harness.repository.findPendingLogin(pending.credential.prefix)
                ).toMatchObject({ attemptCount: 0 });
                expect(
                    harness.repository.findRateLimitBucket(
                        rateLimitBucketKey("login-mfa-source", mfaLoginClientSourceId)
                    )
                ).toBeUndefined();
                expect(auditCount(harness, "failed")).toBe(1);
            } finally {
                harness.close();
            }
        }
    });

    test("preserves the challenge when timeout occurs before active admission", async () => {
        const harness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies({
                workRuntime: queuedTimeoutWorkRuntime(),
            }),
        });
        try {
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-queued-timeout"
            );
            const result = await harness.service.completeWebAuthnLogin(
                pending.credential,
                { response: await createAuthenticationFixture({ counter: 0 }) },
                mfaLoginMetadata("request-webauthn-queued-timeout-complete")
            );

            expect(result).toEqual({ status: "service-unavailable" });
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeDefined();
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toMatchObject({ attemptCount: 0 });
            expect(auditCount(harness, "failed")).toBe(0);
        } finally {
            harness.close();
        }
    });

    test("leaves challenge untouched for capacity and rolling-budget rejection", async () => {
        for (const webAuthn of [
            webAuthnDependencies({ workRuntime: failingWorkRuntime("capacity") }),
            webAuthnDependencies({
                workBudget: Object.freeze({
                    consume: () => ({
                        accepted: false as const,
                        retryAfterSeconds: 17,
                    }),
                }),
            }),
        ]) {
            const harness = await createMfaLoginHarness({ webAuthn });
            try {
                const { pending } = await beginWebAuthnCeremony(
                    harness,
                    "request-webauthn-admission"
                );
                const result = await harness.service.completeWebAuthnLogin(
                    pending.credential,
                    { response: await createAuthenticationFixture({ counter: 0 }) },
                    mfaLoginMetadata("request-webauthn-admission-complete")
                );

                expect(result.status).toBe("rate-limited");
                expect(
                    harness.repository.findPendingLoginWebAuthnChallenge(
                        pending.credential.prefix
                    )
                ).toBeDefined();
                expect(
                    harness.repository.findPendingLogin(pending.credential.prefix)
                ).toMatchObject({ attemptCount: 0 });
                expect(auditCount(harness, "denied")).toBe(0);
            } finally {
                harness.close();
            }
        }
    });

    test("consumes active cancellation without counting and preserves queued abort", async () => {
        const activeHarness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies({
                workRuntime: cancellationWorkRuntime(),
            }),
        });
        try {
            const { pending } = await beginWebAuthnCeremony(
                activeHarness,
                "request-webauthn-active-cancel"
            );
            expect(
                activeHarness.service.completeWebAuthnLogin(
                    pending.credential,
                    { response: await createAuthenticationFixture({ counter: 0 }) },
                    mfaLoginMetadata("request-webauthn-active-cancel-complete")
                )
            ).rejects.toMatchObject({ name: "AbortError" });
            expect(
                activeHarness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(
                activeHarness.repository.findPendingLogin(pending.credential.prefix)
            ).toMatchObject({ attemptCount: 0 });
            expect(auditCount(activeHarness, "cancelled")).toBe(1);
        } finally {
            activeHarness.close();
        }

        const queuedHarness = await createMfaLoginHarness({
            webAuthn: webAuthnDependencies(),
        });
        try {
            const { pending } = await beginWebAuthnCeremony(
                queuedHarness,
                "request-webauthn-queued-cancel"
            );
            const controller = new AbortController();
            controller.abort(new DOMException("Queued request aborted", "AbortError"));
            expect(
                queuedHarness.service.completeWebAuthnLogin(
                    pending.credential,
                    { response: await createAuthenticationFixture({ counter: 0 }) },
                    {
                        ...mfaLoginMetadata("request-webauthn-queued-cancel-complete"),
                        signal: controller.signal,
                    }
                )
            ).rejects.toMatchObject({ name: "AbortError" });
            expect(
                queuedHarness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeDefined();
            expect(auditCount(queuedHarness, "cancelled")).toBe(0);
        } finally {
            queuedHarness.close();
        }
    });

    test("rejects a cryptographically valid assertion that completes after expiry", async () => {
        let clock = mfaLoginNow;
        const harness = await createMfaLoginHarness({
            now: () => clock,
            webAuthn: webAuthnDependencies({
                adapter: fixedChallengeAdapter({
                    beforeVerification: () => {
                        clock = addMinutes(mfaLoginNow, 5);
                    },
                }),
            }),
        });
        try {
            const { pending } = await beginWebAuthnCeremony(
                harness,
                "request-webauthn-late"
            );
            const result = await harness.service.completeWebAuthnLogin(
                pending.credential,
                { response: await createAuthenticationFixture({ counter: 0 }) },
                mfaLoginMetadata("request-webauthn-late-complete")
            );

            expect(result).toEqual({ status: "invalid-proof" });
            expect(
                harness.repository.findPendingLoginWebAuthnChallenge(
                    pending.credential.prefix
                )
            ).toBeUndefined();
            expect(mfaLoginSessionCount(harness)).toBe(0);
        } finally {
            harness.close();
        }
    });
});
