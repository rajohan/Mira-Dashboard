import { describe, expect, test } from "bun:test";

import { addHours, addMilliseconds, addMinutes, subMilliseconds } from "date-fns";

import { automationPrincipalCapabilities } from "../../../database/schema/automationPrincipalCapabilities.ts";
import { parseOpaqueToken } from "../../../shared/opaqueToken.ts";
import { createRequestAuthenticator } from "../requestAuthentication.ts";
import { createRequestAuthenticationRepository } from "../requestAuthenticationRepository.ts";
import {
    automationLifecycleInitialNow,
    automationLifecyclePrincipalId,
    automationLifecycleSessionCreatedAt,
    automationLifecycleSessionId,
    automationLifecycleUserId,
    deterministicAutomationToken,
    deterministicSecurityId,
    openAutomationLifecycleFixture,
    readAutomationAuditEvents,
    readPersistedAutomationCredentials,
    withAutomationLifecycleRepositoryHooks,
} from "./testSupport/lifecycle.ts";

const principalInput = Object.freeze({
    capabilities: ["notifications:read"] as const,
    id: automationLifecyclePrincipalId,
    initialCredential: Object.freeze({ label: "Initial credential" }),
    label: "Automation lifecycle",
});

describe("automation principal lifecycle", () => {
    test("revalidates recent MFA after acquiring the immediate lock", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const afterRecentMfa = addMinutes(automationLifecycleSessionCreatedAt, 11);
        const repository = withAutomationLifecycleRepositoryHooks(fixture.repository, {
            beforeImmediateCallback: () => fixture.setNow(afterRecentMfa),
        });
        const service = fixture.createService({ repository });

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                )
            ).toEqual({ status: "step-up-required" });
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
            ).toBeUndefined();
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toEqual([]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("revalidates the durable session inside the immediate transaction", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const repository = withAutomationLifecycleRepositoryHooks(fixture.repository, {
            beforeImmediateCallback: () => {
                fixture.database.sqlite
                    .query("DELETE FROM auth_sessions WHERE id = ?")
                    .run(automationLifecycleSessionId);
            },
        });
        const service = fixture.createService({ repository });

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                )
            ).toEqual({ status: "session-changed" });
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
            ).toBeUndefined();
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("captures read time after read-transaction acquisition", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const afterSessionExpiry = addHours(automationLifecycleSessionCreatedAt, 24 * 31);
        const repository = withAutomationLifecycleRepositoryHooks(fixture.repository, {
            beforeReadCallback: () => fixture.setNow(afterSessionExpiry),
        });
        const service = fixture.createService({ repository });

        try {
            expect(service.listPrincipals(fixture.identity, { limit: 10 })).toEqual({
                status: "session-changed",
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed when principal update history is ahead of the process clock", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                ).status
            ).toBe("created");
            fixture.setNow(addMinutes(automationLifecycleInitialNow, 2));
            expect(
                service.replaceCapabilities(
                    fixture.identity,
                    {
                        capabilities: ["notifications:read", "reports:read"],
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                ).status
            ).toBe("replaced");
            fixture.setNow(addMinutes(automationLifecycleInitialNow, 1));
            expect(service.listPrincipals(fixture.identity, { limit: 10 })).toEqual({
                status: "session-changed",
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("guards paginated inventory and creation against future principal history", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();
        const futurePrincipalId = "future-principal";
        const rollbackPrincipalId = "rollback-principal";

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                ).status
            ).toBe("created");
            const futureAt = addMinutes(automationLifecycleInitialNow, 2);
            fixture.setNow(futureAt);
            const future = service.createPrincipal(
                fixture.identity,
                {
                    ...principalInput,
                    id: futurePrincipalId,
                    label: "Future principal",
                },
                fixture.metadata
            );
            expect(future.status).toBe("created");
            if (future.status !== "created") return;

            fixture.setNow(addMinutes(automationLifecycleInitialNow, 1));
            expect(
                service.listPrincipals(fixture.identity, {
                    cursor: {
                        createdAtMs: future.result.principal.createdAtMs,
                        id: futurePrincipalId,
                    },
                    limit: 10,
                })
            ).toEqual({ status: "session-changed" });

            const principalCount = fixture.repository.countPrincipals();
            const credentialCount = readPersistedAutomationCredentials(
                fixture.database.sqlite
            ).length;
            const auditCount = readAutomationAuditEvents(fixture.database.sqlite).length;
            expect(
                service.createPrincipal(
                    fixture.identity,
                    {
                        ...principalInput,
                        id: rollbackPrincipalId,
                        label: "Rollback principal",
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(fixture.repository.findPrincipal(rollbackPrincipalId)).toBeUndefined();
            expect(fixture.repository.countPrincipals()).toBe(principalCount);
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite)
            ).toHaveLength(credentialCount);
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCount
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed for future credential history across inventory cursors", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                ).status
            ).toBe("created");
            const futureAt = addMinutes(automationLifecycleInitialNow, 2);
            fixture.setNow(futureAt);
            const futureCredential = service.createCredential(
                fixture.identity,
                {
                    credential: { label: "Future inventory credential" },
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(futureCredential.status).toBe("created");
            if (futureCredential.status !== "created") return;

            fixture.setNow(addMinutes(automationLifecycleInitialNow, 1));
            expect(service.listPrincipals(fixture.identity, { limit: 10 })).toEqual({
                status: "session-changed",
            });
            expect(
                service.listCredentials(fixture.identity, {
                    cursor: {
                        createdAtMs: futureCredential.result.credential.createdAtMs,
                        id: futureCredential.result.credential.id,
                    },
                    limit: 10,
                    principalId: automationLifecyclePrincipalId,
                })
            ).toEqual({ status: "session-changed" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("denies MFA-disabled administration and fails closed on clock rollback", async () => {
        const mfaDisabled = await openAutomationLifecycleFixture();

        try {
            mfaDisabled.database.sqlite
                .query("UPDATE users SET mfa_enabled_at = NULL WHERE id = ?")
                .run(automationLifecycleUserId);
            expect(
                mfaDisabled
                    .createService()
                    .createPrincipal(
                        mfaDisabled.identity,
                        principalInput,
                        mfaDisabled.metadata
                    )
            ).toEqual({ status: "mfa-enrollment-required" });
        } finally {
            mfaDisabled.database.sqlite.close(true);
        }

        const rolledBack = await openAutomationLifecycleFixture();
        rolledBack.setNow(subMilliseconds(automationLifecycleSessionCreatedAt, 1));
        try {
            expect(
                rolledBack
                    .createService()
                    .createPrincipal(
                        rolledBack.identity,
                        principalInput,
                        rolledBack.metadata
                    )
            ).toEqual({ status: "session-changed" });
        } finally {
            rolledBack.database.sqlite.close(true);
        }
    });

    test("evaluates credential expiry after lock acquisition", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const expiresAt = addMilliseconds(automationLifecycleInitialNow, 1);
        const afterExpiry = addMilliseconds(expiresAt, 1);
        const repository = withAutomationLifecycleRepositoryHooks(fixture.repository, {
            beforeImmediateCallback: () => fixture.setNow(afterExpiry),
        });
        const service = fixture.createService({ repository });

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    {
                        ...principalInput,
                        initialCredential: {
                            expiresAtMs: expiresAt.getTime(),
                            label: "Expiring credential",
                        },
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "invalid-expiry" });
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
            ).toBeUndefined();
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("redacts generation failure while preserving post-lock policy precedence", async () => {
        const authorized = await openAutomationLifecycleFixture();
        try {
            const service = authorized.createService({
                generateToken: () => {
                    throw new Error("raw CSPRNG failure with secret detail");
                },
            });
            expect(
                service.createPrincipal(
                    authorized.identity,
                    principalInput,
                    authorized.metadata
                )
            ).toEqual({ status: "unavailable" });
        } finally {
            authorized.database.sqlite.close(true);
        }

        const stale = await openAutomationLifecycleFixture();
        stale.setNow(addMinutes(automationLifecycleSessionCreatedAt, 11));
        try {
            const service = stale.createService({
                generateId: () => {
                    throw new Error("raw UUID generator failure");
                },
            });
            expect(
                service.createPrincipal(stale.identity, principalInput, stale.metadata)
            ).toEqual({ status: "step-up-required" });
        } finally {
            stale.database.sqlite.close(true);
        }
    });

    test("creates one principal, capability set, and expiring initial token hash", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const expiresAt = addHours(automationLifecycleInitialNow, 1);
        const service = fixture.createService();

        try {
            const created = service.createPrincipal(
                fixture.identity,
                {
                    ...principalInput,
                    capabilities: ["notifications:read", "reports:read"],
                    initialCredential: {
                        expiresAtMs: expiresAt.getTime(),
                        label: "Initial credential",
                    },
                },
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const parsedToken = parseOpaqueToken(created.result.token, "automation");
            expect(parsedToken).toBeDefined();
            const credentials = readPersistedAutomationCredentials(
                fixture.database.sqlite
            );
            expect(credentials).toHaveLength(1);
            expect(credentials[0]).toMatchObject({
                expiresAt: expiresAt.getTime(),
                prefix: parsedToken?.prefix,
                revokedAt: null,
                validatorHash: parsedToken?.validatorHash,
            });
            expect(
                fixture.database.orm
                    .select()
                    .from(automationPrincipalCapabilities)
                    .orderBy(automationPrincipalCapabilities.capability)
                    .all()
                    .map(({ capability, grantedAt }) => ({ capability, grantedAt }))
            ).toEqual([
                {
                    capability: "notifications:read",
                    grantedAt: automationLifecycleInitialNow,
                },
                {
                    capability: "reports:read",
                    grantedAt: automationLifecycleInitialNow,
                },
            ]);

            const authenticator = createRequestAuthenticator({
                now: () => automationLifecycleInitialNow,
                repository: createRequestAuthenticationRepository(fixture.database.orm),
            });
            expect(
                authenticator.authenticate({
                    kind: "automation",
                    token: parsedToken!,
                }).authentication
            ).toMatchObject({ kind: "authenticated" });

            const audits = readAutomationAuditEvents(fixture.database.sqlite);
            expect(audits).toEqual([
                {
                    action: "automation.principal.create",
                    metadataJson:
                        '{"addedCapabilities":["notifications:read","reports:read"]}',
                    occurredAt: automationLifecycleInitialNow.getTime(),
                    targetId: automationLifecyclePrincipalId,
                },
            ]);
            expect(JSON.stringify(created.result.principal)).not.toContain(
                created.result.token
            );
            expect(JSON.stringify(audits)).not.toContain(created.result.token);
            expect(JSON.stringify(audits)).not.toContain(
                parsedToken?.validatorHash ?? "missing-validator-hash"
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rolls principal, grants, and audit back after four candidate collisions", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const collisionPrincipalId = "collision-source";
        const collidingIds = [201, 202, 203, 204].map((index) =>
            deterministicSecurityId(index)
        );

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPrincipalIfAvailable({
                    createdAt: automationLifecycleInitialNow,
                    disabledAt: null,
                    id: collisionPrincipalId,
                    label: "Collision source",
                    updatedAt: automationLifecycleInitialNow,
                });
                for (const [index, id] of collidingIds.entries()) {
                    const token = deterministicAutomationToken(201 + index);
                    unit.insertCredentialIfAvailable({
                        createdAt: automationLifecycleInitialNow,
                        expiresAt: null,
                        id,
                        label: `Collision ${index}`,
                        prefix: token.prefix,
                        principalId: collisionPrincipalId,
                        replacesCredentialId: null,
                        revokedAt: null,
                        validatorHash: token.validatorHash,
                    });
                }
            });
            let idIndex = 0;
            let tokenIndex = 300;
            const service = fixture.createService({
                generateId: () => collidingIds[idIndex++]!,
                generateToken: () => deterministicAutomationToken(tokenIndex++),
            });

            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                )
            ).toEqual({ status: "unavailable" });
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
            ).toBeUndefined();
            expect(
                fixture.database.sqlite
                    .query<{ count: number }, [string]>(`
                        SELECT count(*) AS count
                        FROM automation_principal_capabilities
                        WHERE principal_id = ?
                    `)
                    .get(automationLifecyclePrincipalId)
            ).toEqual({ count: 0 });
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toEqual([]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("keeps same-set capabilities audit-idempotent and gives one CAS winner", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            expect(
                service.createPrincipal(
                    fixture.identity,
                    principalInput,
                    fixture.metadata
                ).status
            ).toBe("created");
            const createdAudits = readAutomationAuditEvents(fixture.database.sqlite);

            fixture.setNow(addMilliseconds(automationLifecycleInitialNow, 1));
            const unchanged = service.replaceCapabilities(
                fixture.identity,
                {
                    capabilities: ["notifications:read"],
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(unchanged).toMatchObject({
                result: {
                    changed: false,
                    principal: { authorizationVersion: 1 },
                },
                status: "replaced",
            });
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toEqual(
                createdAudits
            );

            const changedAt = addMilliseconds(automationLifecycleInitialNow, 2);
            fixture.setNow(changedAt);
            const winner = service.replaceCapabilities(
                fixture.identity,
                {
                    capabilities: ["notifications:read", "reports:read"],
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            const stale = service.replaceCapabilities(
                fixture.identity,
                {
                    capabilities: ["reports:read"],
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(winner).toMatchObject({
                result: {
                    changed: true,
                    principal: { authorizationVersion: 2 },
                },
                status: "replaced",
            });
            expect(stale).toEqual({ status: "conflict" });
            expect(
                fixture.repository.listCapabilities(automationLifecyclePrincipalId)
            ).toEqual([
                {
                    capability: "notifications:read",
                    grantedAt: automationLifecycleInitialNow,
                    principalId: automationLifecyclePrincipalId,
                },
                {
                    capability: "reports:read",
                    grantedAt: changedAt,
                    principalId: automationLifecyclePrincipalId,
                },
            ]);
            const audits = readAutomationAuditEvents(fixture.database.sqlite);
            expect(audits).toHaveLength(2);
            expect(audits[1]?.metadataJson).toBe(
                '{"addedCapabilities":["reports:read"],"removedCapabilities":[]}'
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("disables once, revokes active credentials, and does not grow audit on retry", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = service.createPrincipal(
                fixture.identity,
                principalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const disabledAt = addMilliseconds(automationLifecycleInitialNow, 1);
            fixture.setNow(disabledAt);
            const first = service.disablePrincipal(
                fixture.identity,
                {
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            const auditCount = readAutomationAuditEvents(fixture.database.sqlite).length;
            const retry = service.disablePrincipal(
                fixture.identity,
                {
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );

            expect(first).toMatchObject({
                result: { changed: true, revokedCredentials: 1 },
                status: "disabled",
            });
            expect(retry).toMatchObject({
                result: { changed: false, revokedCredentials: 0 },
                status: "disabled",
            });
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCount
            );
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite)[0]?.revokedAt
            ).toBe(disabledAt.getTime());
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
                    ?.disabledAt
            ).toEqual(disabledAt);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("contains over-cap credential state by disabling and revoking every token", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = service.createPrincipal(
                fixture.identity,
                principalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            fixture.repository.withImmediateTransaction((unit) => {
                for (let index = 0; index < 4; index += 1) {
                    const token = deterministicAutomationToken(500 + index);
                    expect(
                        unit.insertCredentialIfAvailable({
                            createdAt: automationLifecycleInitialNow,
                            expiresAt: null,
                            id: deterministicSecurityId(500 + index),
                            label: `Over-cap credential ${index}`,
                            prefix: token.prefix,
                            principalId: automationLifecyclePrincipalId,
                            replacesCredentialId: null,
                            revokedAt: null,
                            validatorHash: token.validatorHash,
                        })
                    ).toBeDefined();
                }
            });

            const disabledAt = addMilliseconds(automationLifecycleInitialNow, 1);
            fixture.setNow(disabledAt);
            expect(
                service.disablePrincipal(
                    fixture.identity,
                    {
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toMatchObject({
                result: { changed: true, revokedCredentials: 5 },
                status: "disabled",
            });
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite).every(
                    ({ revokedAt }) => revokedAt === disabledAt.getTime()
                )
            ).toBeTrue();
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
                    ?.disabledAt
            ).toEqual(disabledAt);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("contains future credential history through terminal principal disable", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = service.createPrincipal(
                fixture.identity,
                principalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;
            const futureCredentialAt = addMinutes(automationLifecycleInitialNow, 2);
            fixture.setNow(futureCredentialAt);
            const futureCredential = service.createCredential(
                fixture.identity,
                {
                    credential: { label: "Future credential" },
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(futureCredential.status).toBe("created");
            if (futureCredential.status !== "created") return;
            const disabledAt = addMinutes(automationLifecycleInitialNow, 1);
            fixture.setNow(disabledAt);
            expect(
                service.disablePrincipal(
                    fixture.identity,
                    {
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toMatchObject({
                result: { changed: true, revokedCredentials: 1 },
                status: "disabled",
            });
            expect(
                fixture.repository.findPrincipal(automationLifecyclePrincipalId)
                    ?.disabledAt
            ).toEqual(disabledAt);
            const persisted = readPersistedAutomationCredentials(fixture.database.sqlite);
            expect(
                persisted.find(({ id }) => id === created.result.credential.id)?.revokedAt
            ).toBe(disabledAt.getTime());
            expect(
                persisted.find(({ id }) => id === futureCredential.result.credential.id)
                    ?.revokedAt
            ).toBeNull();

            const authenticationAt = addMinutes(futureCredentialAt, 1);
            const authenticator = createRequestAuthenticator({
                now: () => authenticationAt,
                repository: createRequestAuthenticationRepository(fixture.database.orm),
            });
            for (const token of [created.result.token, futureCredential.result.token]) {
                const parsed = parseOpaqueToken(token, "automation");
                expect(parsed).toBeDefined();
                expect(
                    authenticator.authenticate({
                        kind: "automation",
                        token: parsed!,
                    }).authentication
                ).toEqual({ kind: "invalid" });
            }
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
