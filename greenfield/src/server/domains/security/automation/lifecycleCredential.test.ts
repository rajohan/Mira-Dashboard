import { describe, expect, test } from "bun:test";

import { addHours, addMilliseconds, addMinutes } from "date-fns";

import { parseOpaqueToken } from "../../../shared/opaqueToken.ts";
import { createRequestAuthenticator } from "../requestAuthentication.ts";
import { createRequestAuthenticationRepository } from "../requestAuthenticationRepository.ts";
import {
    automationLifecycleInitialNow,
    automationLifecyclePrincipalId,
    deterministicSecurityId,
    openAutomationLifecycleFixture,
    readAutomationAuditEvents,
    readPersistedAutomationCredentials,
    withAutomationLifecycleRepositoryHooks,
} from "./testSupport/lifecycle.ts";

const initialPrincipalInput = Object.freeze({
    capabilities: ["reports:read"] as const,
    id: automationLifecyclePrincipalId,
    initialCredential: Object.freeze({ label: "Initial credential" }),
    label: "Credential lifecycle",
});

function authenticateAutomationToken(
    fixture: Awaited<ReturnType<typeof openAutomationLifecycleFixture>>,
    token: string,
    checkedAt: Date
) {
    const parsed = parseOpaqueToken(token, "automation");
    if (parsed === undefined) throw new Error("Lifecycle test token is invalid");
    return createRequestAuthenticator({
        now: () => checkedAt,
        repository: createRequestAuthenticationRepository(fixture.database.orm),
    }).authenticate({ kind: "automation", token: parsed }).authentication;
}

describe("automation credential lifecycle", () => {
    test("rechecks predecessor expiry after acquiring the rotation lock", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const predecessorExpiry = addMilliseconds(automationLifecycleInitialNow, 1);
        const creationService = fixture.createService();

        try {
            const created = await creationService.createPrincipal(
                fixture.identity,
                {
                    ...initialPrincipalInput,
                    initialCredential: {
                        expiresAtMs: predecessorExpiry.getTime(),
                        label: "Expiring predecessor",
                    },
                },
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const repository = withAutomationLifecycleRepositoryHooks(
                fixture.repository,
                {
                    beforeImmediateCallback: () =>
                        fixture.setNow(addMilliseconds(predecessorExpiry, 1)),
                }
            );
            const rotationService = fixture.createService({ repository });
            const auditCount = readAutomationAuditEvents(fixture.database.sqlite).length;
            expect(
                await rotationService.rotateCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                        replacement: { label: "Too-late replacement" },
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite)
            ).toHaveLength(1);
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCount
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("skips a generated predecessor ID and succeeds with the next candidate", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const creationService = fixture.createService();

        try {
            const created = await creationService.createPrincipal(
                fixture.identity,
                initialPrincipalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const secondCandidateId = deterministicSecurityId(500);
            const generatedIds = [
                created.result.credential.id,
                secondCandidateId,
                deterministicSecurityId(501),
                deterministicSecurityId(502),
                deterministicSecurityId(503),
            ];
            let generatedIdIndex = 0;
            const rotationService = fixture.createService({
                generateId: () => {
                    const id = generatedIds[generatedIdIndex++];
                    if (id === undefined) {
                        throw new Error("Unexpected lifecycle ID generation");
                    }
                    return id;
                },
            });
            const rotation = await rotationService.rotateCredential(
                fixture.identity,
                {
                    credentialId: created.result.credential.id,
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                    replacement: { label: "Collision-safe replacement" },
                },
                fixture.metadata
            );

            expect(rotation.status).toBe("rotated");
            if (rotation.status !== "rotated") return;
            expect(rotation.result.credential.id).toBe(secondCandidateId);
            expect(rotation.result.credential.replacesCredentialId).toBe(
                created.result.credential.id
            );
            expect(generatedIdIndex).toBe(5);
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite).map(
                    ({ id }) => id
                )
            ).toEqual([created.result.credential.id, secondCandidateId]);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("keeps staged predecessor and replacement valid until explicit revocation", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = await service.createPrincipal(
                fixture.identity,
                initialPrincipalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const rotatedAt = addMilliseconds(automationLifecycleInitialNow, 1);
            fixture.setNow(rotatedAt);
            const rotation = await service.rotateCredential(
                fixture.identity,
                {
                    credentialId: created.result.credential.id,
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                    replacement: { label: "Staged replacement" },
                },
                fixture.metadata
            );
            expect(rotation.status).toBe("rotated");
            if (rotation.status !== "rotated") return;
            expect(rotation.result.credential.replacesCredentialId).toBe(
                created.result.credential.id
            );
            expect(
                authenticateAutomationToken(fixture, created.result.token, rotatedAt)
            ).toMatchObject({ kind: "authenticated" });
            expect(
                authenticateAutomationToken(fixture, rotation.result.token, rotatedAt)
            ).toMatchObject({ kind: "authenticated" });

            const auditCountAfterRotation = readAutomationAuditEvents(
                fixture.database.sqlite
            ).length;
            expect(
                await service.rotateCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                        replacement: { label: "Blocked replacement" },
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCountAfterRotation
            );

            const revokedAt = addMilliseconds(rotatedAt, 1);
            fixture.setNow(revokedAt);
            const lostReplacementRevoke = await service.revokeCredential(
                fixture.identity,
                {
                    credentialId: rotation.result.credential.id,
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(lostReplacementRevoke).toMatchObject({
                result: { revoked: true },
                status: "revoked",
            });
            const auditCountAfterRevoke = readAutomationAuditEvents(
                fixture.database.sqlite
            ).length;
            expect(
                await service.revokeCredential(
                    fixture.identity,
                    {
                        credentialId: rotation.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toMatchObject({ result: { revoked: false }, status: "revoked" });
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCountAfterRevoke
            );

            const retriedAt = addMilliseconds(revokedAt, 1);
            fixture.setNow(retriedAt);
            const retry = await service.rotateCredential(
                fixture.identity,
                {
                    credentialId: created.result.credential.id,
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                    replacement: { label: "Recovered replacement" },
                },
                fixture.metadata
            );
            expect(retry.status).toBe("rotated");
            if (retry.status !== "rotated") return;
            expect(retry.result.credential.id).not.toBe(rotation.result.credential.id);
            expect(
                authenticateAutomationToken(fixture, rotation.result.token, retriedAt)
            ).toMatchObject({ kind: "invalid" });
            expect(
                authenticateAutomationToken(fixture, created.result.token, retriedAt)
            ).toMatchObject({ kind: "authenticated" });
            expect(
                authenticateAutomationToken(fixture, retry.result.token, retriedAt)
            ).toMatchObject({ kind: "authenticated" });

            const finalRevokeAt = addMilliseconds(retriedAt, 1);
            fixture.setNow(finalRevokeAt);
            expect(
                await service.revokeCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toMatchObject({ result: { revoked: true }, status: "revoked" });
            expect(
                authenticateAutomationToken(fixture, created.result.token, finalRevokeAt)
            ).toMatchObject({ kind: "invalid" });

            const audits = readAutomationAuditEvents(fixture.database.sqlite);
            const serializedAudits = JSON.stringify(audits);
            for (const token of [
                created.result.token,
                rotation.result.token,
                retry.result.token,
            ]) {
                expect(serializedAudits).not.toContain(token);
                expect(serializedAudits).not.toContain(
                    parseOpaqueToken(token, "automation")?.validatorHash ??
                        "missing-validator-hash"
                );
            }
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("enforces the active credential cap and admits capacity after expiry", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = await service.createPrincipal(
                fixture.identity,
                initialPrincipalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const shortExpiry = addMinutes(automationLifecycleInitialNow, 1);
            const credentialInputs = [
                {
                    expiresAtMs: shortExpiry.getTime(),
                    label: "Short lived",
                },
                { label: "Third credential" },
                { label: "Fourth credential" },
            ] as const;
            for (const credential of credentialInputs) {
                const result = await service.createCredential(
                    fixture.identity,
                    {
                        credential,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                );
                expect(result.status).toBe("created");
            }
            const auditCountAtCapacity = readAutomationAuditEvents(
                fixture.database.sqlite
            ).length;
            expect(
                await service.createCredential(
                    fixture.identity,
                    {
                        credential: { label: "Over capacity" },
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCountAtCapacity
            );

            const afterExpiry = addMilliseconds(shortExpiry, 1);
            fixture.setNow(afterExpiry);
            const createdAfterExpiry = await service.createCredential(
                fixture.identity,
                {
                    credential: {
                        expiresAtMs: addHours(afterExpiry, 1).getTime(),
                        label: "Capacity after expiry",
                    },
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(createdAfterExpiry.status).toBe("created");
            expect(
                fixture.repository.countActiveCredentials(
                    automationLifecyclePrincipalId,
                    afterExpiry
                )
            ).toBe(4);

            const listed = service.listCredentials(fixture.identity, {
                limit: 10,
                principalId: automationLifecyclePrincipalId,
            });
            expect(listed.status).toBe("listed");
            if (listed.status !== "listed") return;
            const serialized = JSON.stringify(listed.result);
            expect(serialized).not.toContain("validatorHash");
            expect(serialized).not.toContain("token");
            for (const credential of readPersistedAutomationCredentials(
                fixture.database.sqlite
            )) {
                expect(serialized).not.toContain(credential.validatorHash);
            }
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("rolls a credential mutation back when audit insertion faults", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = await service.createPrincipal(
                fixture.identity,
                initialPrincipalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const existingAuditId = deterministicSecurityId(104);
            const faulting = fixture.createService({
                generateId: () => existingAuditId,
            });
            const auditCount = readAutomationAuditEvents(fixture.database.sqlite).length;

            expect(
                faulting.revokeCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).rejects.toThrow();
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite)[0]?.revokedAt
            ).toBeNull();
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCount
            );
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed across mutations when credential history is in the future", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = await service.createPrincipal(
                fixture.identity,
                initialPrincipalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const futureAt = addMinutes(automationLifecycleInitialNow, 2);
            fixture.setNow(futureAt);
            let futureCredentialId: string | undefined;
            for (const label of [
                "Future credential one",
                "Future credential two",
                "Future credential three",
            ]) {
                const futureCredential = await service.createCredential(
                    fixture.identity,
                    {
                        credential: { label },
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                );
                expect(futureCredential.status).toBe("created");
                if (futureCredential.status !== "created") return;
                futureCredentialId ??= futureCredential.result.credential.id;
            }
            if (futureCredentialId === undefined) return;
            expect(
                fixture.repository.countActiveCredentials(
                    automationLifecyclePrincipalId,
                    futureAt
                )
            ).toBe(4);

            const rolledBackAt = addMinutes(automationLifecycleInitialNow, 1);
            fixture.setNow(rolledBackAt);
            const credentialCountBeforeRollbackMutations =
                readPersistedAutomationCredentials(fixture.database.sqlite).length;
            const auditCountBeforeRollbackMutations = readAutomationAuditEvents(
                fixture.database.sqlite
            ).length;
            expect(
                await service.createCredential(
                    fixture.identity,
                    {
                        credential: { label: "Rollback overflow" },
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(
                await service.rotateCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                        replacement: { label: "Rollback replacement" },
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite)
            ).toHaveLength(credentialCountBeforeRollbackMutations);
            expect(readAutomationAuditEvents(fixture.database.sqlite)).toHaveLength(
                auditCountBeforeRollbackMutations
            );
            expect(
                service.listCredentials(fixture.identity, {
                    limit: 10,
                    principalId: automationLifecyclePrincipalId,
                })
            ).toEqual({ status: "session-changed" });
            expect(
                await service.revokeCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
            expect(
                readPersistedAutomationCredentials(fixture.database.sqlite).find(
                    (credential) => credential.id === created.result.credential.id
                )?.revokedAt
            ).toBeNull();
            expect(
                await service.revokeCredential(
                    fixture.identity,
                    {
                        credentialId: futureCredentialId,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });

            fixture.setNow(futureAt);
            const futureRevocation = await service.revokeCredential(
                fixture.identity,
                {
                    credentialId: created.result.credential.id,
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(futureRevocation.status).toBe("revoked");
            fixture.setNow(rolledBackAt);
            expect(
                await service.revokeCredential(
                    fixture.identity,
                    {
                        credentialId: created.result.credential.id,
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("fails closed when only credential revocation history is in the future", async () => {
        const fixture = await openAutomationLifecycleFixture();
        const service = fixture.createService();

        try {
            const created = await service.createPrincipal(
                fixture.identity,
                initialPrincipalInput,
                fixture.metadata
            );
            expect(created.status).toBe("created");
            if (created.status !== "created") return;

            const futureAt = addMinutes(automationLifecycleInitialNow, 2);
            fixture.setNow(futureAt);
            const futureRevocation = await service.revokeCredential(
                fixture.identity,
                {
                    credentialId: created.result.credential.id,
                    expectedAuthorizationVersion: 1,
                    principalId: automationLifecyclePrincipalId,
                },
                fixture.metadata
            );
            expect(futureRevocation.status).toBe("revoked");

            fixture.setNow(addMinutes(automationLifecycleInitialNow, 1));
            const credentialCount = readPersistedAutomationCredentials(
                fixture.database.sqlite
            ).length;
            const auditCount = readAutomationAuditEvents(fixture.database.sqlite).length;
            expect(
                service.listCredentials(fixture.identity, {
                    limit: 10,
                    principalId: automationLifecyclePrincipalId,
                })
            ).toEqual({ status: "session-changed" });
            expect(
                await service.createCredential(
                    fixture.identity,
                    {
                        credential: { label: "Rollback credential" },
                        expectedAuthorizationVersion: 1,
                        principalId: automationLifecyclePrincipalId,
                    },
                    fixture.metadata
                )
            ).toEqual({ status: "conflict" });
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
});
