import { describe, expect, test } from "bun:test";

import { browserSessionMaximumPerUser } from "../../../contracts/auth.ts";
import {
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
} from "./testSupport/authenticationLifecycle.ts";

describe("authentication lifecycle sessions", () => {
    test("prunes inactive sessions and caps retained sessions transactionally", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
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
                {
                    clientSourceId: "client-source-1",
                    requestId: "request-after-idle",
                }
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

    test("rejects stale authentication versions at every lifecycle read boundary", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
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
            expect(await harness.service.touchSession(identity)).toBeUndefined();
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("revalidates revoke actors atomically and suppresses no-op audit growth", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
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
                await harness.service.revokeSession(actorIdentity, "b".repeat(32), {
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
                await harness.service.revokeSession(actorIdentity, second.session.id, {
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

    test("requires recent authentication inside the session-revocation transaction", async () => {
        const harness = await createAuthenticationLifecycleHarness({
            recentAuthenticationWindowMs: 60_000,
        });

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const second = await harness.service.login(
                { password: "current-password-1", username: "operator" },
                { clientSourceId: "client-source-2", requestId: "request-second" }
            );
            if (second.status !== "created") {
                throw new Error(`Expected login creation, received ${second.status}`);
            }
            harness.advanceSeconds(61);

            expect(
                await harness.service.revokeSession(
                    { sessionId: created.session.id, userId: created.user.id },
                    second.session.id,
                    { clientSourceId: "client-source-1", requestId: "request-stale" }
                )
            ).toEqual({ status: "step-up-required" });
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
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };

            expect(
                await harness.service.logout(identity, {
                    clientSourceId: "client-source-1",
                    requestId: "request-logout",
                })
            ).toBeTrue();
            expect(
                await harness.service.logout(identity, {
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
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };
            harness.advanceSeconds(60);

            expect(await harness.service.touchSession(identity)).toEqual({
                lastSeenAtMs: new Date("2026-08-05T09:01:00.000Z").getTime(),
            });
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
