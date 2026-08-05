import { describe, expect, test } from "bun:test";

import { addDays } from "date-fns";

import { parseAuthenticationResolution } from "./authenticationResolution.ts";
import {
    createRequestAuthenticator,
    dashboardSessionCookieName,
} from "./requestAuthentication.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    authenticationTestCredentialId,
    openAuthenticationTestDatabase,
} from "./testSupport/authentication.ts";

function automationRequest(token: string, scheme = "Bearer"): Request {
    return new Request("https://dashboard.example/trpc/events.stream", {
        headers: { authorization: `${scheme} ${token}` },
    });
}

describe("automation request authentication", () => {
    test("authenticates a scoped credential without caching or last-used writes", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const resolution = authenticator.authenticate(
                automationRequest(fixture.automation.token, "bEaReR")
            );
            const credential = fixture.database.sqlite
                .query<{ last_used_at: number | null }, []>(
                    "SELECT last_used_at FROM automation_credentials"
                )
                .get();

            expect(resolution.authentication).toEqual({
                kind: "authenticated",
                principal: {
                    authorizationVersion: 1,
                    capabilities: ["reports:read"],
                    authenticatorId: authenticationTestCredentialId,
                    id: authenticationTestPrincipalId,
                    kind: "automation",
                },
            });
            expect(credential?.last_used_at).toBeNull();
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("revalidation observes capability-version changes", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const resolution = authenticator.authenticate(
                automationRequest(fixture.automation.token)
            );
            fixture.database.orm.transaction((transaction) => {
                transaction.run(
                    `DELETE FROM automation_principal_capabilities
                     WHERE principal_id = '${authenticationTestPrincipalId}'`
                );
                transaction.run(
                    `UPDATE automation_principals
                     SET authorization_version = authorization_version + 1
                     WHERE id = '${authenticationTestPrincipalId}'`
                );
            });

            const revalidated = parseAuthenticationResolution(
                await resolution.lease?.revalidate(new AbortController().signal)
            );
            expect(revalidated.authentication).toEqual({
                kind: "authenticated",
                principal: {
                    authorizationVersion: 2,
                    capabilities: [],
                    authenticatorId: authenticationTestCredentialId,
                    id: authenticationTestPrincipalId,
                    kind: "automation",
                },
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rejects mixed automation and browser credentials", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const malformedBearer = new Request("https://dashboard.example/trpc", {
                headers: {
                    authorization: "Basic malformed",
                    cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                },
            });
            const validBearer = new Request("https://dashboard.example/trpc", {
                headers: {
                    authorization: `Bearer ${fixture.automation.token}`,
                    cookie: `${dashboardSessionCookieName}=${fixture.session.token}`,
                },
            });
            const malformedDashboardCookie = new Request(
                "https://dashboard.example/trpc",
                {
                    headers: {
                        authorization: `Bearer ${fixture.automation.token}`,
                        cookie: dashboardSessionCookieName,
                    },
                }
            );
            const unrelatedCookie = new Request("https://dashboard.example/trpc", {
                headers: {
                    authorization: `Bearer ${fixture.automation.token}`,
                    cookie: "theme=dark",
                },
            });

            expect(authenticator.authenticate(malformedBearer).authentication).toEqual({
                kind: "invalid",
            });
            expect(authenticator.authenticate(validBearer).authentication).toEqual({
                kind: "invalid",
            });
            expect(
                authenticator.authenticate(malformedDashboardCookie).authentication
            ).toEqual({ kind: "invalid" });
            expect(authenticator.authenticate(unrelatedCookie).authentication).toEqual({
                kind: "authenticated",
                principal: {
                    authorizationVersion: 1,
                    capabilities: ["reports:read"],
                    authenticatorId: authenticationTestCredentialId,
                    id: authenticationTestPrincipalId,
                    kind: "automation",
                },
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed for unknown, revoked, disabled, and expired credentials", async () => {
        for (const state of ["unknown", "revoked", "disabled", "expired"] as const) {
            const fixture = await openAuthenticationTestDatabase();
            try {
                if (state === "revoked") {
                    fixture.database.sqlite.run(
                        "UPDATE automation_credentials SET revoked_at = created_at"
                    );
                }
                if (state === "disabled") {
                    fixture.database.sqlite.run(
                        "UPDATE automation_principals SET disabled_at = updated_at"
                    );
                }
                const authenticator = createRequestAuthenticator({
                    now: () =>
                        state === "expired"
                            ? addDays(authenticationTestNow, 31)
                            : authenticationTestNow,
                    repository: fixture.repository,
                });
                const token =
                    state === "unknown"
                        ? `${"f".repeat(32)}.${"e".repeat(64)}`
                        : fixture.automation.token;

                expect(
                    authenticator.authenticate(automationRequest(token)).authentication
                ).toEqual({ kind: "invalid" });
            } finally {
                fixture.database.sqlite.close(true);
            }
        }
    });
});
