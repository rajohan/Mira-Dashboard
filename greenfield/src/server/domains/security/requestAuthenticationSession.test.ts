import { describe, expect, test } from "bun:test";

import {
    addMinutes,
    addSeconds,
    getTime,
    minutesToMilliseconds,
    secondsToMilliseconds,
} from "date-fns";

import { applicationCapabilities } from "../../../contracts/security.ts";
import type { RawAuthenticationCredential } from "../../rawHttp/authenticationCredentials.ts";
import { parseOpaqueToken } from "../../shared/opaqueToken.ts";
import { parseAuthenticationResolution } from "./authenticationResolution.ts";
import {
    createRequestAuthenticator,
    type RequestAuthenticator,
} from "./requestAuthentication.ts";
import type { RequestAuthenticationRepository } from "./requestAuthenticationRepository.ts";
import {
    authenticationTestNow,
    authenticationTestUserId,
    openAuthenticationTestDatabase,
} from "./testSupport/authentication.ts";

function sessionCredential(token: string): RawAuthenticationCredential {
    const parsed = parseOpaqueToken(token, "session");
    if (parsed === undefined) throw new Error("Expected a valid session fixture");
    return { kind: "session", token: parsed };
}

function authenticateCredential(
    authenticator: RequestAuthenticator,
    credential: RawAuthenticationCredential
) {
    return authenticator.authenticate(credential).authentication;
}

describe("session request authentication", () => {
    test("enforces the documented minimum session idle lifetime", () => {
        const repository = {
            findAutomationByCredentialId: (): undefined => {},
            findAutomationByPrefix: (): undefined => {},
            findSessionById: (): undefined => {},
        } satisfies RequestAuthenticationRepository;

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
                sessionCredential(fixture.session.token)
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
                    capabilities: applicationCapabilities,
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

    test("rejects invalid and unknown credential DTOs while preserving anonymous", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const unknownToken = `${"f".repeat(32)}.${"e".repeat(64)}`;

            expect(authenticateCredential(authenticator, { kind: "invalid" })).toEqual({
                kind: "invalid",
            });
            expect(
                authenticateCredential(authenticator, sessionCredential(unknownToken))
            ).toEqual({ kind: "invalid" });
            expect(authenticateCredential(authenticator, { kind: "anonymous" })).toEqual({
                kind: "anonymous",
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed when session activity is ahead of the process clock", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            fixture.database.sqlite.run(
                "UPDATE auth_sessions SET last_seen_at = last_seen_at + 60000 WHERE id = ?",
                [fixture.session.prefix]
            );
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });

            expect(
                authenticateCredential(
                    authenticator,
                    sessionCredential(fixture.session.token)
                )
            ).toEqual({ kind: "invalid" });
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
                authenticateCredential(
                    idleAuthenticator,
                    sessionCredential(fixture.session.token)
                )
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
                authenticateCredential(
                    versionAuthenticator,
                    sessionCredential(fixture.session.token)
                )
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
                authenticateCredential(
                    authenticator,
                    sessionCredential(fixture.session.token)
                )
            ).toEqual({
                kind: "invalid",
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("requires session MFA evidence after MFA is enabled", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            fixture.database.sqlite.run(
                "UPDATE users SET mfa_enabled_at = updated_at WHERE id = ?",
                [authenticationTestUserId]
            );
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });

            expect(
                authenticateCredential(
                    authenticator,
                    sessionCredential(fixture.session.token)
                )
            ).toEqual({ kind: "invalid" });

            fixture.database.sqlite.run(
                "UPDATE auth_sessions SET mfa_verified_at = created_at WHERE id = ?",
                [fixture.session.prefix]
            );
            expect(
                authenticateCredential(
                    authenticator,
                    sessionCredential(fixture.session.token)
                )
            ).toMatchObject({ kind: "authenticated" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
