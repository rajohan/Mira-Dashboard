import { describe, expect, test } from "bun:test";

import { captureFailure } from "../../test/support/promise.ts";
import {
    authenticationAbortError,
    authenticationLifecycleMetadata,
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
    fakeAuthenticationPasswordHash,
} from "./testSupport/authenticationLifecycle.ts";

describe("authentication lifecycle bootstrap", () => {
    test("bootstraps the sole user and persists only the session validator", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            expect(harness.service.status()).toEqual({
                authenticated: false,
                isBootstrapRequired: true,
            });
            harness.setGatewayCredentialIsValid(false);
            expect(
                await harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "invalid-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "invalid-gateway" });
            expect(
                await harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "another-invalid-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        ...authenticationLifecycleMetadata,
                        clientSourceId: "client-source-2",
                        requestId: "request-2",
                    }
                )
            ).toEqual({ status: "invalid-gateway" });

            harness.setGatewayCredentialIsValid(true);
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };

            expect(harness.service.status(identity)).toMatchObject({
                authenticated: true,
                isBootstrapRequired: false,
                user: { username: "operator" },
            });
            expect(harness.service.listSessions(identity)).toHaveLength(1);
            const stored = harness.database.sqlite
                .query<{ userAgent: string | null; validatorHash: string }, [string]>(`
                    SELECT
                        user_agent AS "userAgent",
                        validator_hash AS "validatorHash"
                    FROM auth_sessions
                    WHERE id = ?
                `)
                .get(created.session.id);
            expect(stored?.validatorHash).toMatch(/^[a-f\d]{64}$/u);
            expect(stored?.validatorHash).not.toBe(created.token);
            expect(stored?.userAgent).toBe("Test Browser");
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_rate_limit_buckets"
                    )
                    .get()
            ).toEqual({ count: 0 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("times out a hanging Gateway verifier and releases after abort settlement", async () => {
        let verificationCalls = 0;
        let timeoutSignalAborted = false;
        const harness = await createAuthenticationLifecycleHarness({
            gatewayVerificationTimeoutMs: 100,
            verifyGatewayCredential: (_credential, signal) => {
                verificationCalls += 1;
                if (verificationCalls > 1) return Promise.resolve(true);
                if (signal === undefined) {
                    return Promise.reject(new Error("Missing Gateway abort signal"));
                }
                return new Promise<boolean>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => {
                            timeoutSignalAborted = true;
                            reject(authenticationAbortError(signal));
                        },
                        { once: true }
                    );
                });
            },
        });

        try {
            const unavailable = await harness.service.bootstrap(
                {
                    email: "operator@example.com",
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                authenticationLifecycleMetadata
            );
            expect(unavailable.status).toBe("gateway-unavailable");
            expect(timeoutSignalAborted).toBeTrue();
            const created = await bootstrapAuthenticationLifecycle(harness);
            expect(created.status).toBe("created");
            expect(verificationCalls).toBe(2);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("does not accumulate Gateway work when a timed-out verifier ignores abort", async () => {
        const pendingVerifications: PromiseWithResolvers<boolean>[] = [];
        let verificationCalls = 0;
        const harness = await createAuthenticationLifecycleHarness({
            gatewayVerificationTimeoutMs: 100,
            verifyGatewayCredential: () => {
                verificationCalls += 1;
                const pending = Promise.withResolvers<boolean>();
                pendingVerifications.push(pending);
                return pending.promise;
            },
        });

        try {
            for (const clientSourceId of ["source-1", "source-2"]) {
                const unavailable = await harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "gateway-token",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        clientSourceId,
                        requestId: `request-${clientSourceId}`,
                    }
                );
                expect(unavailable.status).toBe("gateway-unavailable");
            }

            const limited = await harness.service.bootstrap(
                {
                    email: "operator@example.com",
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                {
                    clientSourceId: "source-3",
                    requestId: "request-source-3",
                }
            );
            expect(limited.status).toBe("rate-limited");
            expect(verificationCalls).toBe(2);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 2 });
        } finally {
            for (const pending of pendingVerifications) pending.resolve(false);
            harness.database.sqlite.close(true);
        }
    });

    test.each(["invalid", "unavailable"] as const)(
        "does not persist a late %s Gateway result after bootstrap closes",
        async (lateOutcome) => {
            const bothStarted = Promise.withResolvers<void>();
            const verifications = new Map<string, PromiseWithResolvers<boolean>>();
            const harness = await createAuthenticationLifecycleHarness({
                verifyGatewayCredential: (credential) => {
                    const verification = Promise.withResolvers<boolean>();
                    verifications.set(credential, verification);
                    if (verifications.size === 2) bothStarted.resolve();
                    return verification.promise;
                },
            });

            try {
                const winner = harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "gateway-winner",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        ...authenticationLifecycleMetadata,
                        requestId: "request-winner",
                    }
                );
                const late = harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "gateway-late",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        ...authenticationLifecycleMetadata,
                        clientSourceId: "client-source-2",
                        requestId: "request-late",
                    }
                );
                await bothStarted.promise;
                const winnerVerification = verifications.get("gateway-winner");
                const lateVerification = verifications.get("gateway-late");
                if (winnerVerification === undefined || lateVerification === undefined) {
                    throw new Error("Expected both Gateway verifications to start");
                }

                winnerVerification.resolve(true);
                const created = await winner;
                expect(created.status).toBe("created");
                if (lateOutcome === "invalid") {
                    lateVerification.resolve(false);
                } else {
                    lateVerification.reject(new Error("Gateway unavailable"));
                }

                expect(await late).toEqual({ status: "closed" });
                expect(
                    harness.database.sqlite
                        .query<{ count: number }, []>(
                            "SELECT count(*) AS count FROM auth_rate_limit_buckets"
                        )
                        .get()
                ).toEqual({ count: 0 });
                expect(
                    harness.database.sqlite
                        .query<{ count: number }, []>(
                            "SELECT count(*) AS count FROM audit_events"
                        )
                        .get()
                ).toEqual({ count: 1 });
            } finally {
                for (const verification of verifications.values()) {
                    verification.resolve(false);
                }
                harness.database.sqlite.close(true);
            }
        }
    );

    test("propagates request abort during Gateway verification without persistence", async () => {
        const started = Promise.withResolvers<void>();
        const harness = await createAuthenticationLifecycleHarness({
            verifyGatewayCredential: (_credential, signal) => {
                if (signal === undefined) {
                    return Promise.reject(new Error("Missing Gateway abort signal"));
                }
                started.resolve();
                return new Promise<boolean>((_resolve, reject) => {
                    signal.addEventListener(
                        "abort",
                        () => reject(authenticationAbortError(signal)),
                        { once: true }
                    );
                });
            },
        });
        const controller = new AbortController();

        try {
            const pending = harness.service.bootstrap(
                {
                    email: "operator@example.com",
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                { ...authenticationLifecycleMetadata, signal: controller.signal }
            );
            await started.promise;
            controller.abort(new Error("request cancelled"));

            expect(await captureFailure(() => pending)).toBe(controller.signal.reason);
            for (const table of [
                "audit_events",
                "auth_rate_limit_buckets",
                "auth_sessions",
                "users",
            ]) {
                expect(
                    harness.database.sqlite
                        .query<{ count: number }, []>(
                            `SELECT count(*) AS count FROM ${table}`
                        )
                        .get()
                ).toEqual({ count: 0 });
            }
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("does not commit bootstrap after its password hash request is aborted", async () => {
        const hashStarted = Promise.withResolvers<void>();
        const hashResult = Promise.withResolvers<string>();
        const harness = await createAuthenticationLifecycleHarness({
            hashPassword: () => {
                hashStarted.resolve();
                return hashResult.promise;
            },
        });
        const controller = new AbortController();

        try {
            const pending = harness.service.bootstrap(
                {
                    email: "operator@example.com",
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                { ...authenticationLifecycleMetadata, signal: controller.signal }
            );
            await hashStarted.promise;
            controller.abort(new Error("request cancelled"));
            hashResult.resolve(fakeAuthenticationPasswordHash("current-password-1"));

            expect(await captureFailure(() => pending)).toBe(controller.signal.reason);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>("SELECT count(*) AS count FROM users")
                    .get()
            ).toEqual({ count: 0 });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 0 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("hashes only once when valid bootstrap attempts overlap", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const results = await Promise.all([
                harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "gateway-token",
                        password: "current-password-1",
                        username: "operator",
                    },
                    { clientSourceId: "client-source-1", requestId: "request-a" }
                ),
                harness.service.bootstrap(
                    {
                        email: "operator@example.com",
                        gatewayCredential: "gateway-token",
                        password: "replacement-password-2",
                        username: "operator-two",
                    },
                    { clientSourceId: "client-source-1", requestId: "request-b" }
                ),
            ]);

            expect(results.map((result) => result.status).toSorted()).toEqual([
                "closed",
                "created",
            ]);
            expect(harness.passwordHashCalls()).toBe(1);
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
