import { describe, expect, test } from "bun:test";

import {
    addMinutes,
    addSeconds,
    getTime,
    minutesToMilliseconds,
    secondsToMilliseconds,
} from "date-fns";

import { parseAuthenticationResolution } from "./authenticationResolution.ts";
import type { AuthenticationRepository } from "./repository.ts";
import {
    createRequestAuthenticator,
    dashboardSessionCookieName,
} from "./requestAuthentication.ts";
import {
    authenticationTestNow,
    authenticationTestUserId,
    openAuthenticationTestDatabase,
} from "./testSupport/authentication.ts";

function sessionRequest(token: string): Request {
    return new Request("https://dashboard.example/trpc/events.stream", {
        headers: { cookie: `${dashboardSessionCookieName}=${token}` },
    });
}

describe("session request authentication", () => {
    test("enforces the documented minimum session idle lifetime", () => {
        const repository = {
            findAutomationByCredentialId: (): undefined => {},
            findAutomationByPrefix: (): undefined => {},
            findSessionById: (): undefined => {},
        } satisfies AuthenticationRepository;

        expect(() =>
            createRequestAuthenticator({
                repository,
                sessionIdleDurationMs: minutesToMilliseconds(4),
            })
        ).toThrow(RangeError);
        expect(() =>
            createRequestAuthenticator({
                authenticationLeaseDurationMs: secondsToMilliseconds(0.5),
                repository,
            })
        ).toThrow(RangeError);
    });

    test("authenticates without touching idle activity and bounds the lease", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                authenticationLeaseDurationMs: secondsToMilliseconds(30),
                now: () => authenticationTestNow,
                repository: fixture.repository,
                sessionIdleDurationMs: minutesToMilliseconds(30),
            });
            const before = fixture.database.sqlite
                .query<{ last_seen_at: number }, []>(
                    "SELECT last_seen_at FROM auth_sessions"
                )
                .get();
            const resolution = authenticator.authenticate(
                sessionRequest(fixture.session.token)
            );
            const after = fixture.database.sqlite
                .query<{ last_seen_at: number }, []>(
                    "SELECT last_seen_at FROM auth_sessions"
                )
                .get();

            expect(resolution.authentication).toEqual({
                kind: "authenticated",
                principal: {
                    authorizationVersion: 1,
                    capabilities: ["notifications:read", "reports:read"],
                    authenticatorId: fixture.session.prefix,
                    id: authenticationTestUserId,
                    kind: "session",
                },
            });
            expect(resolution.lease?.expiresAtMs).toBe(
                getTime(addSeconds(authenticationTestNow, 30))
            );
            expect(after).toEqual(before);

            fixture.database.sqlite.run("DELETE FROM auth_sessions");
            const revalidated = await resolution.lease?.revalidate(
                new AbortController().signal
            );
            const parsedRevalidation = parseAuthenticationResolution(revalidated);
            expect(parsedRevalidation.authentication).toEqual({ kind: "invalid" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rejects malformed, duplicate, and unknown session cookies", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const duplicate = new Request("https://dashboard.example/trpc", {
                headers: {
                    cookie: `${dashboardSessionCookieName}=${fixture.session.token}; ${dashboardSessionCookieName}=${fixture.session.token}`,
                },
            });
            const unknownToken = `${"f".repeat(32)}.${"e".repeat(64)}`;

            expect(
                authenticator.authenticate(sessionRequest("malformed")).authentication
            ).toEqual({ kind: "invalid" });
            expect(authenticator.authenticate(duplicate).authentication).toEqual({
                kind: "invalid",
            });
            expect(
                authenticator.authenticate(sessionRequest(unknownToken)).authentication
            ).toEqual({ kind: "invalid" });
            expect(
                authenticator.authenticate(new Request("https://dashboard.example/trpc"))
                    .authentication
            ).toEqual({ kind: "anonymous" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed on idle expiry and authentication-version changes", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const idleAuthenticator = createRequestAuthenticator({
                now: () => addMinutes(authenticationTestNow, 31),
                repository: fixture.repository,
                sessionIdleDurationMs: minutesToMilliseconds(30),
            });
            expect(
                idleAuthenticator.authenticate(sessionRequest(fixture.session.token))
                    .authentication
            ).toEqual({ kind: "invalid" });

            fixture.database.sqlite.run(
                "UPDATE users SET authentication_version = 2 WHERE id = ?",
                [authenticationTestUserId]
            );
            const versionAuthenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            expect(
                versionAuthenticator.authenticate(sessionRequest(fixture.session.token))
                    .authentication
            ).toEqual({ kind: "invalid" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed for a disabled user", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            fixture.database.sqlite.run(
                "UPDATE users SET disabled_at = updated_at WHERE id = ?",
                [authenticationTestUserId]
            );
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });

            expect(
                authenticator.authenticate(sessionRequest(fixture.session.token))
                    .authentication
            ).toEqual({ kind: "invalid" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
