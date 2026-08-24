import { describe, expect, test } from "bun:test";

import { captureFailure } from "../../test/support/promise.ts";
import {
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
    fakeAuthenticationPasswordHash,
} from "./testSupport/authenticationLifecycle.ts";

function enableRecentMfa(
    harness: Awaited<ReturnType<typeof createAuthenticationLifecycleHarness>>,
    userId: string,
    sessionId: string
): void {
    harness.database.sqlite.run(
        `
            UPDATE users
            SET mfa_enabled_at = created_at, updated_at = created_at
            WHERE id = ?
        `,
        [userId]
    );
    harness.database.sqlite.run(
        `
            UPDATE auth_sessions
            SET auth_method = 'totp', mfa_verified_at = created_at
            WHERE id = ? AND user_id = ?
        `,
        [sessionId, userId]
    );
}

function persistedCounts(
    harness: Awaited<ReturnType<typeof createAuthenticationLifecycleHarness>>
): { readonly audits: number; readonly rateLimits: number; readonly sessions: number } {
    const count = (table: string): number =>
        harness.database.sqlite
            .query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
            .get()?.count ?? -1;
    return {
        audits: count("audit_events"),
        rateLimits: count("auth_rate_limit_buckets"),
        sessions: count("auth_sessions"),
    };
}

describe("authentication lifecycle password change", () => {
    test("honors a non-default recent-auth window", async () => {
        const harness = await createAuthenticationLifecycleHarness({
            recentAuthenticationWindowMs: 60_000,
        });

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            enableRecentMfa(harness, identity.userId, identity.sessionId);
            harness.advanceSeconds(61);

            expect(
                await harness.service.changePassword(
                    identity,
                    {
                        currentPassword: "current-password-1",
                        newPassword: "replacement-password-2",
                    },
                    {
                        clientSourceId: "client-source-1",
                        requestId: "request-non-default-recent-auth-window",
                    }
                )
            ).toEqual({ status: "step-up-required" });
            expect(harness.passwordVerificationCalls()).toBe(0);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("does not rotate password or sessions after replacement hashing is aborted", async () => {
        const replacementHashStarted = Promise.withResolvers<void>();
        const replacementHash = Promise.withResolvers<string>();
        let hashCalls = 0;
        const harness = await createAuthenticationLifecycleHarness({
            hashPassword: (password) => {
                hashCalls += 1;
                if (hashCalls === 1) {
                    return Promise.resolve(fakeAuthenticationPasswordHash(password));
                }
                replacementHashStarted.resolve();
                return replacementHash.promise;
            },
        });
        const controller = new AbortController();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
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
            replacementHash.resolve(
                fakeAuthenticationPasswordHash("replacement-password-2")
            );

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
            expect(persistedCounts(harness).sessions).toBe(1);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("rotates the current session and revokes every older session", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const first = await bootstrapAuthenticationLifecycle(harness);
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

    test("does not repeat Argon2 work for a queued stale request", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
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

    test("does not record a stale invalid-password request after session revocation", async () => {
        const verificationStarted = Promise.withResolvers<void>();
        const verification = Promise.withResolvers<boolean>();
        const harness = await createAuthenticationLifecycleHarness({
            verifyPassword: () => {
                verificationStarted.resolve();
                return verification.promise;
            },
        });

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            const before = persistedCounts(harness);
            const pending = harness.service.changePassword(
                identity,
                {
                    currentPassword: "wrong-current-password",
                    newPassword: "replacement-password-2",
                },
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-stale-invalid-password",
                }
            );
            await verificationStarted.promise;
            harness.database.sqlite.run(
                "DELETE FROM auth_sessions WHERE id = ? AND user_id = ?",
                [identity.sessionId, identity.userId]
            );
            verification.resolve(false);

            expect(await pending).toEqual({ status: "session-changed" });
            expect(persistedCounts(harness)).toEqual({ ...before, sessions: 0 });
        } finally {
            verification.resolve(false);
            harness.database.sqlite.close(true);
        }
    });

    test("returns step-up without recording when MFA freshness expires during verification", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            enableRecentMfa(harness, identity.userId, identity.sessionId);
            const before = persistedCounts(harness);
            harness.setPasswordVerificationAdvanceSeconds(601);

            expect(
                await harness.service.changePassword(
                    identity,
                    {
                        currentPassword: "wrong-current-password",
                        newPassword: "replacement-password-2",
                    },
                    {
                        clientSourceId: "client-source-1",
                        requestId: "request-expired-during-verification",
                    }
                )
            ).toEqual({ status: "step-up-required" });
            expect(persistedCounts(harness)).toEqual(before);
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("returns step-up without rotating when MFA freshness expires during hashing", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            enableRecentMfa(harness, identity.userId, identity.sessionId);
            const before = persistedCounts(harness);
            const beforeUser = harness.database.sqlite
                .query<
                    { authenticationVersion: number; passwordHash: string },
                    [string]
                >(`
                    SELECT
                        authentication_version AS "authenticationVersion",
                        password_hash AS "passwordHash"
                    FROM users
                    WHERE id = ?
                `)
                .get(identity.userId);
            harness.setPasswordHashAdvanceSeconds(601);

            expect(
                await harness.service.changePassword(
                    identity,
                    {
                        currentPassword: "current-password-1",
                        newPassword: "replacement-password-2",
                    },
                    {
                        clientSourceId: "client-source-1",
                        requestId: "request-expired-during-hashing",
                    }
                )
            ).toEqual({ status: "step-up-required" });
            expect(persistedCounts(harness)).toEqual(before);
            expect(
                harness.database.sqlite
                    .query<
                        { authenticationVersion: number; passwordHash: string },
                        [string]
                    >(`
                        SELECT
                            authentication_version AS "authenticationVersion",
                            password_hash AS "passwordHash"
                        FROM users
                        WHERE id = ?
                    `)
                    .get(identity.userId)
            ).toEqual(beforeUser);
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
