import { describe, expect, test } from "bun:test";

import { addDays, addMilliseconds, getTime, subMilliseconds } from "date-fns";

import type { RawAuthenticationCredential } from "../../rawHttp/authenticationCredentials.ts";
import { parseOpaqueToken } from "../../shared/opaqueToken.ts";
import { parseAuthenticationResolution } from "./authenticationResolution.ts";
import {
    createRequestAuthenticator,
    type RequestAuthenticator,
} from "./requestAuthentication.ts";
import {
    authenticationTestNow,
    authenticationTestPrincipalId,
    authenticationTestCredentialId,
    openAuthenticationTestDatabase,
} from "./testSupport/authentication.ts";

function automationCredential(token: string): RawAuthenticationCredential {
    const parsed = parseOpaqueToken(token, "automation");
    if (parsed === undefined) throw new Error("Expected a valid automation fixture");
    return { kind: "automation", token: parsed };
}

function authenticateCredential(
    authenticator: RequestAuthenticator,
    credential: RawAuthenticationCredential
) {
    return authenticator.authenticate(credential).authentication;
}

describe("automation request authentication", () => {
    test("authenticates a scoped credential without caching or database writes", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const changesBefore = fixture.database.sqlite
                .query<{ count: number }, []>("SELECT total_changes() AS count")
                .get()?.count;
            const resolution = authenticator.authenticate(
                automationCredential(fixture.automation.token)
            );
            const changesAfter = fixture.database.sqlite
                .query<{ count: number }, []>("SELECT total_changes() AS count")
                .get()?.count;

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
            expect(changesAfter).toBe(changesBefore);
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
                automationCredential(fixture.automation.token)
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

    test("preserves invalid and anonymous credential boundaries", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            expect(
                authenticator.authenticate({ kind: "invalid" }).authentication
            ).toEqual({ kind: "invalid" });
            expect(
                authenticator.authenticate({ kind: "anonymous" }).authentication
            ).toEqual({ kind: "anonymous" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed when automation state is ahead of the process clock", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const credential = automationCredential(fixture.automation.token);

            fixture.database.sqlite.run(
                "UPDATE automation_credentials SET created_at = created_at + 60000"
            );
            expect(authenticateCredential(authenticator, credential)).toEqual({
                kind: "invalid",
            });

            fixture.database.sqlite.run(
                "UPDATE automation_credentials SET created_at = created_at - 60000"
            );
            fixture.database.sqlite.run(
                "UPDATE automation_principals SET updated_at = updated_at + 60000"
            );
            expect(authenticateCredential(authenticator, credential)).toEqual({
                kind: "invalid",
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test.each(["future", "before-principal", "after-update"] as const)(
        "fails closed when any capability grant is %s",
        async (state) => {
            const fixture = await openAuthenticationTestDatabase();

            try {
                fixture.database.sqlite.run(
                    `INSERT INTO automation_principal_capabilities (
                        capability,
                        granted_at,
                        principal_id
                    ) VALUES ('notifications:read', ?, ?)`,
                    [getTime(authenticationTestNow), authenticationTestPrincipalId]
                );
                let grantedAt = authenticationTestNow;
                if (state === "future") {
                    grantedAt = addMilliseconds(authenticationTestNow, 1);
                } else if (state === "before-principal") {
                    grantedAt = subMilliseconds(authenticationTestNow, 1);
                } else {
                    fixture.database.sqlite.run(
                        `UPDATE automation_principals
                         SET created_at = ?, updated_at = ?
                         WHERE id = ?`,
                        [
                            getTime(subMilliseconds(authenticationTestNow, 2)),
                            getTime(subMilliseconds(authenticationTestNow, 1)),
                            authenticationTestPrincipalId,
                        ]
                    );
                }
                fixture.database.sqlite.run(
                    `UPDATE automation_principal_capabilities
                     SET granted_at = ?
                     WHERE principal_id = ? AND capability = 'reports:read'`,
                    [getTime(grantedAt), authenticationTestPrincipalId]
                );

                const authenticator = createRequestAuthenticator({
                    now: () => authenticationTestNow,
                    repository: fixture.repository,
                });
                expect(
                    authenticateCredential(
                        authenticator,
                        automationCredential(fixture.automation.token)
                    )
                ).toEqual({ kind: "invalid" });
            } finally {
                fixture.database.sqlite.close(true);
            }
        }
    );

    test("lease revalidation observes an invalid capability grant without writes", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            const authenticator = createRequestAuthenticator({
                now: () => authenticationTestNow,
                repository: fixture.repository,
            });
            const resolution = authenticator.authenticate(
                automationCredential(fixture.automation.token)
            );
            fixture.database.sqlite.run(
                `UPDATE automation_principal_capabilities
                 SET granted_at = ?
                 WHERE principal_id = ?`,
                [
                    getTime(addMilliseconds(authenticationTestNow, 1)),
                    authenticationTestPrincipalId,
                ]
            );

            const revalidated = parseAuthenticationResolution(
                await resolution.lease?.revalidate(new AbortController().signal)
            );
            const persistedGrant = fixture.database.sqlite
                .query<{ granted_at: number }, []>(
                    "SELECT granted_at FROM automation_principal_capabilities"
                )
                .get();

            expect(revalidated.authentication).toEqual({ kind: "invalid" });
            expect(persistedGrant?.granted_at).toBe(
                getTime(addMilliseconds(authenticationTestNow, 1))
            );
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
                    authenticateCredential(authenticator, automationCredential(token))
                ).toEqual({ kind: "invalid" });
            } finally {
                fixture.database.sqlite.close(true);
            }
        }
    });
});
