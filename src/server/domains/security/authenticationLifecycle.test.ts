import { describe, expect, test } from "bun:test";

import { addSeconds } from "date-fns";

import { browserSessionMaximumPerUser } from "../../../contracts/auth.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createAuthenticationLifecycleService,
    type VerifyGatewayCredential,
} from "./authenticationLifecycle.ts";
import {
    createAuthenticationWorkBudget,
    type AuthenticationWorkBudget,
} from "./authenticationWorkBudget.ts";
import { createAuthenticationLifecycleRepository } from "./lifecycleRepository.ts";

const metadata = Object.freeze({
    clientSourceId: "client-source-1",
    requestId: "request-1",
    userAgent: " \tTest\0 Browser\n",
});

function fakePasswordHash(password: string): string {
    return `$argon2id$v=19$m=65536,t=3,p=1$${"A".repeat(43)}$${sha256Hex(password).slice(0, 42)}E`;
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Authentication request aborted", "AbortError");
}

interface HarnessOptions {
    readonly gatewayVerificationTimeoutMs?: number;
    readonly hashPassword?: (password: string) => Promise<string>;
    readonly passwordWorkBudget?: AuthenticationWorkBudget;
    readonly verifyGatewayCredential?: VerifyGatewayCredential;
    readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

async function createHarness(options: HarnessOptions = {}) {
    const database = await openFreshMigratedDatabase();
    let clock = new Date("2026-08-05T09:00:00.000Z");
    let gatewayCredentialIsValid = true;
    let gatewayVerificationError: Error | undefined;
    let gatewayVerificationCalls = 0;
    let passwordHashCalls = 0;
    let passwordVerificationAdvanceSeconds = 0;
    let passwordVerificationCalls = 0;
    const service = createAuthenticationLifecycleService({
        generateId: () => Bun.randomUUIDv7(),
        ...(options.gatewayVerificationTimeoutMs !== undefined && {
            gatewayVerificationTimeoutMs: options.gatewayVerificationTimeoutMs,
        }),
        hashPassword: (password) => {
            passwordHashCalls += 1;
            return (
                options.hashPassword?.(password) ??
                Promise.resolve(fakePasswordHash(password))
            );
        },
        now: () => clock,
        ...(options.passwordWorkBudget !== undefined && {
            passwordWorkBudget: options.passwordWorkBudget,
        }),
        repository: createAuthenticationLifecycleRepository(database.orm),
        verifyGatewayCredential: (credential, signal) => {
            gatewayVerificationCalls += 1;
            if (options.verifyGatewayCredential !== undefined) {
                return options.verifyGatewayCredential(credential, signal);
            }
            return gatewayVerificationError === undefined
                ? Promise.resolve(gatewayCredentialIsValid)
                : Promise.reject(gatewayVerificationError);
        },
        verifyPassword: async (password, hash) => {
            passwordVerificationCalls += 1;
            const result = await (options.verifyPassword?.(password, hash) ??
                Promise.resolve(hash === fakePasswordHash(password)));
            clock = addSeconds(clock, passwordVerificationAdvanceSeconds);
            return result;
        },
    });
    return {
        advanceSeconds(seconds: number) {
            clock = addSeconds(clock, seconds);
        },
        database,
        gatewayVerificationCalls: () => gatewayVerificationCalls,
        passwordHashCalls: () => passwordHashCalls,
        passwordVerificationCalls: () => passwordVerificationCalls,
        service,
        setGatewayCredentialIsValid(value: boolean) {
            gatewayCredentialIsValid = value;
        },
        setGatewayVerificationError(error: Error | undefined) {
            gatewayVerificationError = error;
        },
        setPasswordVerificationAdvanceSeconds(seconds: number) {
            passwordVerificationAdvanceSeconds = seconds;
        },
    };
}

async function bootstrap(
    harness: Awaited<ReturnType<typeof createHarness>>,
    password = "current-password-1"
) {
    const result = await harness.service.bootstrap(
        {
            gatewayCredential: "gateway-token",
            password,
            username: "operator",
        },
        metadata
    );
    if (result.status !== "created") {
        throw new Error(`Expected bootstrap creation, received ${result.status}`);
    }
    return result;
}

describe("authentication lifecycle", () => {
    test("bootstraps the sole user and persists only the session validator", async () => {
        const harness = await createHarness();

        try {
            expect(harness.service.status()).toEqual({
                authenticated: false,
                isBootstrapRequired: true,
            });
            harness.setGatewayCredentialIsValid(false);
            expect(
                await harness.service.bootstrap(
                    {
                        gatewayCredential: "invalid-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    metadata
                )
            ).toEqual({ status: "invalid-gateway" });
            expect(
                await harness.service.bootstrap(
                    {
                        gatewayCredential: "another-invalid-gateway",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        ...metadata,
                        clientSourceId: "client-source-2",
                        requestId: "request-2",
                    }
                )
            ).toEqual({ status: "invalid-gateway" });

            harness.setGatewayCredentialIsValid(true);
            const created = await bootstrap(harness);
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

    test("shares one source budget across rotating usernames and serializes bursts", async () => {
        const harness = await createHarness();

        try {
            await bootstrap(harness);
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
        const harness = await createHarness();

        try {
            await bootstrap(harness);
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
        const harness = await createHarness();

        try {
            await bootstrap(harness);
            harness.setPasswordVerificationAdvanceSeconds(20);
            let thresholdResult;
            for (let index = 0; index < 3; index += 1) {
                thresholdResult = await harness.service.login(
                    { password: `wrong-delayed-password-${index}`, username: "operator" },
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
        const harness = await createHarness({
            passwordWorkBudget: createAuthenticationWorkBudget(2, 60_000, () => 0),
        });

        try {
            await bootstrap(harness);
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
        const harness = await createHarness();

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

    test("times out a hanging Gateway verifier and releases after abort settlement", async () => {
        let verificationCalls = 0;
        let timeoutSignalAborted = false;
        const harness = await createHarness({
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
                            reject(abortError(signal));
                        },
                        { once: true }
                    );
                });
            },
        });

        try {
            const unavailable = await harness.service.bootstrap(
                {
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                metadata
            );
            expect(unavailable.status).toBe("gateway-unavailable");
            expect(timeoutSignalAborted).toBeTrue();
            const created = await bootstrap(harness);
            expect(created.status).toBe("created");
            expect(verificationCalls).toBe(2);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("does not accumulate Gateway work when a timed-out verifier ignores abort", async () => {
        const pendingVerifications: PromiseWithResolvers<boolean>[] = [];
        let verificationCalls = 0;
        const harness = await createHarness({
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
            const harness = await createHarness({
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
                        gatewayCredential: "gateway-winner",
                        password: "current-password-1",
                        username: "operator",
                    },
                    { ...metadata, requestId: "request-winner" }
                );
                const late = harness.service.bootstrap(
                    {
                        gatewayCredential: "gateway-late",
                        password: "current-password-1",
                        username: "operator",
                    },
                    {
                        ...metadata,
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
        const harness = await createHarness({
            verifyGatewayCredential: (_credential, signal) => {
                if (signal === undefined) {
                    return Promise.reject(new Error("Missing Gateway abort signal"));
                }
                started.resolve();
                return new Promise<boolean>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(abortError(signal)), {
                        once: true,
                    });
                });
            },
        });
        const controller = new AbortController();

        try {
            const pending = harness.service.bootstrap(
                {
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                { ...metadata, signal: controller.signal }
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
        const harness = await createHarness({
            hashPassword: () => {
                hashStarted.resolve();
                return hashResult.promise;
            },
        });
        const controller = new AbortController();

        try {
            const pending = harness.service.bootstrap(
                {
                    gatewayCredential: "gateway-token",
                    password: "current-password-1",
                    username: "operator",
                },
                { ...metadata, signal: controller.signal }
            );
            await hashStarted.promise;
            controller.abort(new Error("request cancelled"));
            hashResult.resolve(fakePasswordHash("current-password-1"));

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

    test("does not commit login after password verification is aborted", async () => {
        const verificationStarted = Promise.withResolvers<void>();
        const verificationResult = Promise.withResolvers<boolean>();
        const harness = await createHarness({
            verifyPassword: () => {
                verificationStarted.resolve();
                return verificationResult.promise;
            },
        });
        const controller = new AbortController();

        try {
            await bootstrap(harness);
            const pending = harness.service.login(
                { password: "current-password-1", username: "operator" },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-aborted-login",
                    signal: controller.signal,
                }
            );
            await verificationStarted.promise;
            controller.abort(new Error("request cancelled"));
            verificationResult.resolve(true);

            expect(await captureFailure(() => pending)).toBe(controller.signal.reason);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_sessions"
                    )
                    .get()
            ).toEqual({ count: 1 });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 1 });
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

    test("does not rotate password or sessions after replacement hashing is aborted", async () => {
        const replacementHashStarted = Promise.withResolvers<void>();
        const replacementHash = Promise.withResolvers<string>();
        let hashCalls = 0;
        const harness = await createHarness({
            hashPassword: (password) => {
                hashCalls += 1;
                if (hashCalls === 1) {
                    return Promise.resolve(fakePasswordHash(password));
                }
                replacementHashStarted.resolve();
                return replacementHash.promise;
            },
        });
        const controller = new AbortController();

        try {
            const created = await bootstrap(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            const pending = harness.service.changePassword(
                identity,
                {
                    currentPassword: "current-password-1",
                    newPassword: "replacement-password-2",
                },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-aborted-password-change",
                    signal: controller.signal,
                }
            );
            await replacementHashStarted.promise;
            controller.abort(new Error("request cancelled"));
            replacementHash.resolve(fakePasswordHash("replacement-password-2"));

            expect(await captureFailure(() => pending)).toBe(controller.signal.reason);
            expect(harness.service.status(identity).authenticated).toBeTrue();
            expect(
                harness.database.sqlite
                    .query<{ authenticationVersion: number }, []>(`
                        SELECT authentication_version AS "authenticationVersion"
                        FROM users
                    `)
                    .get()
            ).toEqual({ authenticationVersion: 1 });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_sessions"
                    )
                    .get()
            ).toEqual({ count: 1 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("prunes inactive sessions and caps retained sessions transactionally", async () => {
        const harness = await createHarness();

        try {
            const created = await bootstrap(harness);
            for (let index = 0; index < 3; index += 1) {
                await harness.service.login(
                    { password: "current-password-1", username: "operator" },
                    {
                        clientSourceId: "client-source-1",
                        requestId: `request-before-idle-${index}`,
                    }
                );
            }
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_sessions"
                    )
                    .get()
            ).toEqual({ count: 4 });

            harness.advanceSeconds(30 * 60);
            let latest = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                { clientSourceId: "client-source-1", requestId: "request-after-idle" }
            );
            if (latest.status !== "created") {
                throw new Error(`Expected login creation, received ${latest.status}`);
            }
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_sessions"
                    )
                    .get()
            ).toEqual({ count: 1 });

            for (let index = 0; index < browserSessionMaximumPerUser + 4; index += 1) {
                latest = await harness.service.login(
                    { password: "current-password-1", username: "operator" },
                    {
                        clientSourceId: "client-source-1",
                        requestId: `request-capped-${index}`,
                    }
                );
                if (latest.status !== "created") {
                    throw new Error(`Expected login creation, received ${latest.status}`);
                }
            }
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_sessions"
                    )
                    .get()
            ).toEqual({ count: browserSessionMaximumPerUser });
            expect(
                harness.service.listSessions({
                    sessionId: latest.session.id,
                    userId: created.user.id,
                })
            ).toHaveLength(browserSessionMaximumPerUser);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("hashes only once when valid bootstrap attempts overlap", async () => {
        const harness = await createHarness();

        try {
            const results = await Promise.all([
                harness.service.bootstrap(
                    {
                        gatewayCredential: "gateway-token",
                        password: "current-password-1",
                        username: "operator",
                    },
                    { clientSourceId: "client-source-1", requestId: "request-a" }
                ),
                harness.service.bootstrap(
                    {
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

    test("rotates the current session and revokes every older session on password change", async () => {
        const harness = await createHarness();

        try {
            const first = await bootstrap(harness);
            const second = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                { clientSourceId: "client-source-1", requestId: "request-2" }
            );
            if (second.status !== "created") {
                throw new Error(`Expected login creation, received ${second.status}`);
            }
            const firstIdentity = {
                sessionId: first.session.id,
                userId: first.user.id,
            };

            harness.advanceSeconds(1);
            const changed = await harness.service.changePassword(
                firstIdentity,
                {
                    currentPassword: "current-password-1",
                    newPassword: "replacement-password-2",
                },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-3",
                    userAgent: "Changed Browser",
                }
            );
            if (changed.status !== "changed") {
                throw new Error(`Expected password change, received ${changed.status}`);
            }

            expect(changed.revokedSessions).toBe(1);
            expect(harness.service.status(firstIdentity).authenticated).toBeFalse();
            expect(
                harness.service.status({
                    sessionId: second.session.id,
                    userId: second.user.id,
                }).authenticated
            ).toBeFalse();
            expect(
                harness.service.status({
                    sessionId: changed.session.id,
                    userId: changed.user.id,
                }).authenticated
            ).toBeTrue();
            expect(
                harness.database.sqlite
                    .query<{ authenticationVersion: number }, [string]>(`
                        SELECT authentication_version AS "authenticationVersion"
                        FROM users
                        WHERE id = ?
                    `)
                    .get(first.user.id)
            ).toEqual({ authenticationVersion: 2 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("does not repeat Argon2 work for a queued stale password-change request", async () => {
        const harness = await createHarness();

        try {
            const created = await bootstrap(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            const results = await Promise.all([
                harness.service.changePassword(
                    identity,
                    {
                        currentPassword: "current-password-1",
                        newPassword: "replacement-password-2",
                    },
                    { clientSourceId: "client-source-1", requestId: "request-a" }
                ),
                harness.service.changePassword(
                    identity,
                    {
                        currentPassword: "current-password-1",
                        newPassword: "replacement-password-3",
                    },
                    { clientSourceId: "client-source-1", requestId: "request-b" }
                ),
            ]);

            expect(results.map((result) => result.status)).toEqual([
                "changed",
                "session-changed",
            ]);
            expect(harness.passwordVerificationCalls()).toBe(1);
            expect(harness.passwordHashCalls()).toBe(2);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("rejects stale authentication versions at every lifecycle read boundary", async () => {
        const harness = await createHarness();

        try {
            const created = await bootstrap(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            harness.database.sqlite.run(
                "UPDATE users SET authentication_version = 2 WHERE id = ?",
                [created.user.id]
            );

            expect(harness.service.status(identity)).toEqual({
                authenticated: false,
                isBootstrapRequired: false,
            });
            expect(harness.service.listSessions(identity)).toBeUndefined();
            expect(harness.service.touchSession(identity)).toBeUndefined();
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("revalidates revoke actors atomically and suppresses no-op audit growth", async () => {
        const harness = await createHarness();

        try {
            const created = await bootstrap(harness);
            const actorIdentity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            const second = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                { clientSourceId: "client-source-2", requestId: "request-second" }
            );
            if (second.status !== "created") {
                throw new Error(`Expected login creation, received ${second.status}`);
            }
            const auditCount = (): number =>
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()?.count ?? -1;

            const beforeNoop = auditCount();
            expect(
                harness.service.revokeSession(actorIdentity, "b".repeat(32), {
                    clientSourceId: "client-source-1",
                    requestId: "request-noop-revoke",
                })
            ).toEqual({ revoked: false });
            expect(auditCount()).toBe(beforeNoop);

            harness.database.sqlite.run("DELETE FROM auth_sessions WHERE id = ?", [
                actorIdentity.sessionId,
            ]);
            expect(harness.service.listSessions(actorIdentity)).toBeUndefined();
            const beforeStale = auditCount();
            expect(
                harness.service.revokeSession(actorIdentity, second.session.id, {
                    clientSourceId: "client-source-1",
                    requestId: "request-stale-revoke",
                })
            ).toBeUndefined();
            expect(auditCount()).toBe(beforeStale);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, [string]>(
                        "SELECT count(*) AS count FROM auth_sessions WHERE id = ?"
                    )
                    .get(second.session.id)
            ).toEqual({ count: 1 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("audits a successful logout once without repeatable no-op growth", async () => {
        const harness = await createHarness();

        try {
            const created = await bootstrap(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };

            expect(
                harness.service.logout(identity, {
                    clientSourceId: "client-source-1",
                    requestId: "request-logout",
                })
            ).toBeTrue();
            expect(
                harness.service.logout(identity, {
                    clientSourceId: "client-source-1",
                    requestId: "request-repeat-logout",
                })
            ).toBeFalse();
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM audit_events"
                    )
                    .get()
            ).toEqual({ count: 2 });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("touches activity at the exact write interval boundary", async () => {
        const harness = await createHarness();

        try {
            const created = await bootstrap(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            harness.advanceSeconds(60);

            expect(harness.service.touchSession(identity)).toEqual({
                lastSeenAtMs: new Date("2026-08-05T09:01:00.000Z").getTime(),
            });
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
