import { describe, expect, test } from "bun:test";

import { Effect, Layer, Stream } from "effect";

import { RealtimeEventPumpService } from "../../platform/realtime/eventPumpService.ts";
import { createApplicationRuntime } from "../../platform/runtime/applicationRuntime.ts";
import { createTestStructuredLogger } from "../../test/support/requestContext.ts";
import { createAuthenticationWorkBudget } from "./authenticationWorkBudget.ts";
import {
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
} from "./testSupport/authenticationLifecycle.ts";

const inertRealtimeLayer = Layer.succeed(
    RealtimeEventPumpService,
    RealtimeEventPumpService.of({
        metricsSnapshot: Effect.die("Authentication rate-limit tests do not use metrics"),
        stream: () => Stream.empty,
        wake: Effect.void,
    })
);

const testStructuredLogger = createTestStructuredLogger();

describe("authentication lifecycle rate limits", () => {
    test("commits Gateway cooldown before admitting the production Effect queue", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                gatewayMaximumConcurrent: 1,
                gatewayMaximumQueued: 5,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const firstStarted = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        let verificationCalls = 0;
        await runtime.initialize();
        const harness = await createAuthenticationLifecycleHarness({
            gatewayWorkRuntime: runtime.services.authentication,
            verifyGatewayCredential: async () => {
                verificationCalls += 1;
                if (verificationCalls === 1) {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
                return false;
            },
        });

        try {
            const attempts = Array.from({ length: 6 }, (_, index) =>
                harness.service.bootstrap(
                    {
                        gatewayCredential: "invalid-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        clientSourceId: "queued-gateway-source",
                        requestId: `request-queued-gateway-${index}`,
                    }
                )
            );
            await firstStarted.promise;
            await Promise.resolve();
            releaseFirst.resolve();
            const results = await Promise.all(attempts);

            expect(verificationCalls).toBe(3);
            expect(
                results.filter(({ status }) => status === "invalid-gateway")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 3 });
        } finally {
            releaseFirst.resolve();
            harness.database.sqlite.close(true);
            await runtime.dispose();
        }
    });

    test("commits Gateway upstream failure before releasing the Effect queue", async () => {
        const runtime = createApplicationRuntime({
            authenticationWork: {
                gatewayMaximumConcurrent: 1,
                gatewayMaximumQueued: 5,
            },
            logger: testStructuredLogger,
            realtimeEventPumpLayer: inertRealtimeLayer,
        });
        const firstStarted = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        let verificationCalls = 0;
        await runtime.initialize();
        const harness = await createAuthenticationLifecycleHarness({
            gatewayWorkRuntime: runtime.services.authentication,
            verifyGatewayCredential: async () => {
                verificationCalls += 1;
                if (verificationCalls === 1) {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
                throw new Error("Simulated Gateway outage");
            },
        });

        try {
            const attempts = Array.from({ length: 6 }, (_, index) =>
                harness.service.bootstrap(
                    {
                        gatewayCredential: "unavailable-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        clientSourceId: "queued-gateway-outage-source",
                        requestId: `request-queued-gateway-outage-${index}`,
                    }
                )
            );
            await firstStarted.promise;
            await Promise.resolve();
            releaseFirst.resolve();
            const results = await Promise.all(attempts);

            expect(verificationCalls).toBe(3);
            expect(
                results.filter(({ status }) => status === "gateway-unavailable")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 3 });
        } finally {
            releaseFirst.resolve();
            harness.database.sqlite.close(true);
            await runtime.dispose();
        }
    });

    test("stops concurrent Gateway failures at the atomic source threshold", async () => {
        const bothStarted = Promise.withResolvers<void>();
        const pendingVerifications: PromiseWithResolvers<boolean>[] = [];
        let deferVerifications = false;
        const harness = await createAuthenticationLifecycleHarness({
            verifyGatewayCredential: () => {
                if (!deferVerifications) return Promise.resolve(false);
                const pending = Promise.withResolvers<boolean>();
                pendingVerifications.push(pending);
                if (pendingVerifications.length === 2) bothStarted.resolve();
                return pending.promise;
            },
        });

        try {
            for (let index = 0; index < 2; index += 1) {
                expect(
                    await harness.service.bootstrap(
                        {
                            gatewayCredential: "invalid-gateway",
                            password: "current-password-1",
                            username: "operator",
                        },
                        {
                            clientSourceId: "shared-source",
                            requestId: `request-prime-${index}`,
                        }
                    )
                ).toEqual({ status: "invalid-gateway" });
            }

            deferVerifications = true;
            const concurrent = ["request-race-a", "request-race-b"].map((requestId) =>
                harness.service.bootstrap(
                    {
                        gatewayCredential: "invalid-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    { clientSourceId: "shared-source", requestId }
                )
            );
            await bothStarted.promise;
            for (const pending of pendingVerifications) pending.resolve(false);

            const results = await Promise.all(concurrent);
            expect(results.map((result) => result.status)).toEqual([
                "rate-limited",
                "rate-limited",
            ]);
            expect(
                harness.database.sqlite
                    .query<{ failureCount: number }, []>(`
                        SELECT failure_count AS "failureCount"
                        FROM auth_rate_limit_buckets
                        ORDER BY kind
                    `)
                    .all()
            ).toEqual([{ failureCount: 3 }, { failureCount: 3 }]);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 3 });
        } finally {
            for (const pending of pendingVerifications) pending.resolve(false);
            harness.database.sqlite.close(true);
        }
    });

    test("shares one source budget across rotating usernames and serializes bursts", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            await bootstrapAuthenticationLifecycle(harness);
            const results = await Promise.all(
                ["alpha", "bravo", "charlie", "delta"].map((username, index) =>
                    harness.service.login(
                        { password: `wrong-password-${index}`, username },
                        {
                            clientSourceId: "client-source-1",
                            requestId: `request-${index + 2}`,
                        }
                    )
                )
            );

            expect(results.map((result) => result.status)).toEqual([
                "invalid-credentials",
                "invalid-credentials",
                "rate-limited",
                "rate-limited",
            ]);
            expect(harness.passwordVerificationCalls()).toBe(3);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_rate_limit_buckets"
                    )
                    .get()
            ).toEqual({ count: 2 });
            expect(
                harness.database.sqlite
                    .query<{ failureCount: number }, []>(`
                        SELECT failure_count AS "failureCount"
                        FROM auth_rate_limit_buckets
                        ORDER BY kind
                    `)
                    .all()
            ).toEqual([{ failureCount: 3 }, { failureCount: 3 }]);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("isolates source cooldowns while retaining a higher global circuit", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            await bootstrapAuthenticationLifecycle(harness);
            const firstSourceStatuses: string[] = [];
            for (let index = 0; index < 3; index += 1) {
                const result = await harness.service.login(
                    {
                        password: `wrong-password-a-${index}`,
                        username: "operator",
                    },
                    {
                        clientSourceId: "client-source-a",
                        requestId: `request-source-a-${index}`,
                    }
                );
                firstSourceStatuses.push(result.status);
            }
            expect(firstSourceStatuses).toEqual([
                "invalid-credentials",
                "invalid-credentials",
                "rate-limited",
            ]);
            const secondSourceFailure = await harness.service.login(
                {
                    password: "wrong-password-b",
                    username: "operator",
                },
                {
                    clientSourceId: "client-source-b",
                    requestId: "request-source-b",
                }
            );
            expect(secondSourceFailure.status).toBe("invalid-credentials");

            const successful = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                {
                    clientSourceId: "client-source-b",
                    requestId: "request-source-b-success",
                }
            );
            expect(successful.status).toBe("created");
            expect(
                harness.database.sqlite
                    .query<{ failureCount: number }, [string]>(`
                        SELECT failure_count AS "failureCount"
                        FROM auth_rate_limit_buckets
                        WHERE kind = ?
                    `)
                    .get("login-password-global")
            ).toEqual({ failureCount: 4 });

            const rotatingStatuses: string[] = [];
            for (let index = 0; index < 16; index += 1) {
                const result = await harness.service.login(
                    {
                        password: `wrong-rotating-password-${index}`,
                        username: "operator",
                    },
                    {
                        clientSourceId: `rotating-source-${index}`,
                        requestId: `request-rotating-${index}`,
                    }
                );
                rotatingStatuses.push(result.status);
            }
            expect(rotatingStatuses.slice(0, -1)).toEqual(
                Array.from({ length: 15 }, () => "invalid-credentials")
            );
            expect(rotatingStatuses.at(-1)).toBe("rate-limited");
            const globallyLimited = await harness.service.login(
                { password: "another-wrong-password", username: "operator" },
                {
                    clientSourceId: "new-source-after-global-limit",
                    requestId: "request-after-global-limit",
                }
            );
            expect(globallyLimited.status).toBe("rate-limited");
            expect(harness.passwordVerificationCalls()).toBe(21);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("starts cooldown at verification completion rather than admission", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            await bootstrapAuthenticationLifecycle(harness);
            harness.setPasswordVerificationAdvanceSeconds(20);
            let thresholdResult;
            for (let index = 0; index < 3; index += 1) {
                thresholdResult = await harness.service.login(
                    {
                        password: `wrong-delayed-password-${index}`,
                        username: "operator",
                    },
                    {
                        clientSourceId: "delayed-source",
                        requestId: `request-delayed-${index}`,
                    }
                );
            }

            expect(thresholdResult).toEqual({
                retryAfterSeconds: 15,
                status: "rate-limited",
            });
            expect(
                harness.database.sqlite
                    .query<{ blockDurationMs: number }, [string]>(`
                        SELECT blocked_until - updated_at AS "blockDurationMs"
                        FROM auth_rate_limit_buckets
                        WHERE kind = ?
                    `)
                    .get("login-password-source")
            ).toEqual({ blockDurationMs: 15_000 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("counts successful password work against the global CPU budget", async () => {
        const harness = await createAuthenticationLifecycleHarness({
            passwordWorkBudget: createAuthenticationWorkBudget(2, 60_000, () => 0),
        });

        try {
            await bootstrapAuthenticationLifecycle(harness);
            const successful = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-budget-success",
                }
            );
            expect(successful.status).toBe("created");
            const limited = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-budget-limited",
                }
            );
            expect(limited.status).toBe("rate-limited");
            expect(harness.passwordVerificationCalls()).toBe(1);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("rate-limits fast Gateway failures before audit rows can grow unbounded", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            harness.setGatewayVerificationError(new Error("Gateway unavailable"));
            const statuses: string[] = [];
            for (let index = 0; index < 4; index += 1) {
                const result = await harness.service.bootstrap(
                    {
                        gatewayCredential: "gateway-token",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        clientSourceId: "client-source-1",
                        requestId: `request-gateway-${index}`,
                    }
                );
                statuses.push(result.status);
            }

            expect(statuses).toEqual([
                "gateway-unavailable",
                "gateway-unavailable",
                "rate-limited",
                "rate-limited",
            ]);
            expect(harness.gatewayVerificationCalls()).toBe(3);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 3 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
