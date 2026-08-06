import { describe, expect, test } from "bun:test";

import {
    authenticationTestCredentialId,
    authenticationTestNow,
    authenticationTestPrincipalId,
    authenticationTestUserId,
    openAuthenticationTestDatabase,
} from "./testSupport/authentication.ts";

describe("request authentication repository", () => {
    test("validates session and automation aggregates at raw-read boundaries", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            expect(fixture.repository.findSessionById(fixture.session.prefix)).toEqual({
                authenticationVersion: 1,
                createdAt: authenticationTestNow,
                expiresAt: fixture.expiresAt,
                id: fixture.session.prefix,
                lastSeenAt: authenticationTestNow,
                mfaVerifiedAt: null,
                userAuthenticationVersion: 1,
                userDisabledAt: null,
                userId: authenticationTestUserId,
                userMfaEnabledAt: null,
                validatorHash: fixture.session.validatorHash,
                validatorVersion: 1,
            });
            expect(
                fixture.repository.findAutomationByPrefix(fixture.automation.prefix)
            ).toEqual({
                capabilities: ["reports:read"],
                credentialCreatedAt: authenticationTestNow,
                credentialExpiresAt: fixture.expiresAt,
                credentialId: authenticationTestCredentialId,
                credentialPrefix: fixture.automation.prefix,
                credentialRevokedAt: null,
                principalAuthorizationVersion: 1,
                principalCreatedAt: authenticationTestNow,
                principalDisabledAt: null,
                principalId: authenticationTestPrincipalId,
                principalUpdatedAt: authenticationTestNow,
                validatorHash: fixture.automation.validatorHash,
                validatorVersion: 1,
            });
            expect(
                fixture.repository.findAutomationByCredentialId(
                    authenticationTestCredentialId
                )
            ).toEqual(
                fixture.repository.findAutomationByPrefix(fixture.automation.prefix)
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("does not cache changed automation grants", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            expect(
                fixture.repository.findAutomationByPrefix(fixture.automation.prefix)
                    ?.capabilities
            ).toEqual(["reports:read"]);

            fixture.database.sqlite.run(
                `DELETE FROM automation_principal_capabilities
                 WHERE principal_id = ? AND capability = 'reports:read'`,
                [authenticationTestPrincipalId]
            );

            expect(
                fixture.repository.findAutomationByPrefix(fixture.automation.prefix)
                    ?.capabilities
            ).toEqual([]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("treats unsupported opaque-token validator versions as misses", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            fixture.database.sqlite.run("PRAGMA ignore_check_constraints = ON");
            fixture.database.sqlite.run(
                "UPDATE auth_sessions SET validator_version = 2 WHERE id = ?",
                [fixture.session.prefix]
            );
            fixture.database.sqlite.run(
                "UPDATE automation_credentials SET validator_version = 2 WHERE id = ?",
                [authenticationTestCredentialId]
            );

            expect(fixture.repository.findSessionById(fixture.session.prefix)).toBe(
                undefined
            );
            expect(
                fixture.repository.findAutomationByPrefix(fixture.automation.prefix)
            ).toBe(undefined);
            expect(
                fixture.repository.findAutomationByCredentialId(
                    authenticationTestCredentialId
                )
            ).toBe(undefined);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed when persisted capability data violates Valibot", async () => {
        const fixture = await openAuthenticationTestDatabase();

        try {
            fixture.database.sqlite.run("PRAGMA ignore_check_constraints = ON");
            fixture.database.sqlite.run(
                `UPDATE automation_principal_capabilities
                 SET capability = 'root:everything'
                 WHERE principal_id = ?`,
                [authenticationTestPrincipalId]
            );

            expect(() =>
                fixture.repository.findAutomationByPrefix(fixture.automation.prefix)
            ).toThrow("Application capability is invalid");
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
