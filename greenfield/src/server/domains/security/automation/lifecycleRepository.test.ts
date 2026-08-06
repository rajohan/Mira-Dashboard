import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addMilliseconds, addMinutes } from "date-fns";
import { drizzle } from "drizzle-orm/bun-sqlite";

import {
    auditEventId,
    automationPrincipalId,
    securityCreatedAt,
    validAuditEventInsert,
    validAutomationCredentialInsert,
    validAutomationPrincipalInsert,
} from "../../../database/validation/testSupport/securityRows.ts";
import { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import { createAutomationLifecycleRepository } from "./lifecycleRepository.ts";

const paginationCredentialIds = [
    "019fc968-1a9b-7771-8f1b-d5b863b0e7a1",
    "019fc968-1a9b-7771-8f1b-d5b863b0e7a2",
    "019fc968-1a9b-7771-8f1b-d5b863b0e7a3",
] as const;
const activeCredentialId = "019fc968-1a9b-7772-8f1b-d5b863b0e7a1";
const expiredCredentialId = "019fc968-1a9b-7772-8f1b-d5b863b0e7a2";
const revokedCredentialId = "019fc968-1a9b-7772-8f1b-d5b863b0e7a3";
const futureCredentialId = "019fc968-1a9b-7772-8f1b-d5b863b0e7a4";
const firstReplacementId = "019fc968-1a9b-7773-8f1b-d5b863b0e7a1";
const secondReplacementId = "019fc968-1a9b-7773-8f1b-d5b863b0e7a2";
const collidingCredentialId = "019fc968-1a9b-7774-8f1b-d5b863b0e7a1";

function indexedHex(index: number, length: number): string {
    return index.toString(16).padStart(length, "0");
}

async function openAutomationRepositoryFixture() {
    const database = await openFreshMigratedDatabase();
    return {
        ...database,
        repository: createAutomationLifecycleRepository(database.orm),
    };
}

describe("automation lifecycle repository", () => {
    test("runs callbacks synchronously after acquiring the SQLite immediate lock", async () => {
        const directory = await mkdtemp(
            path.join(tmpdir(), "mira-automation-repository-")
        );
        const databasePath = path.join(directory, "dashboard.sqlite");
        const primary = new Database(databasePath, { create: true, strict: true });
        const competing = new Database(databasePath, { strict: true });
        competing.run("PRAGMA busy_timeout = 0");
        const repository = createAutomationLifecycleRepository(
            drizzle({ client: primary })
        );

        try {
            let deferredCompetingWriterAcquired = false;
            repository.withReadTransaction(() => {
                competing.run("BEGIN IMMEDIATE");
                deferredCompetingWriterAcquired = true;
                competing.run("ROLLBACK");
            });
            expect(deferredCompetingWriterAcquired).toBeTrue();

            let callbackFinished = false;
            let immediateCompetingWriterFailure: unknown;
            const result = repository.withImmediateTransaction(() => {
                try {
                    competing.run("BEGIN IMMEDIATE");
                    competing.run("ROLLBACK");
                } catch (error) {
                    immediateCompetingWriterFailure = error;
                }
                callbackFinished = true;
                return "synchronous-result";
            });

            expect(callbackFinished).toBeTrue();
            expect(result).toBe("synchronous-result");
            expect(immediateCompetingWriterFailure).toBeInstanceOf(Error);
            expect(String(immediateCompetingWriterFailure)).toContain(
                "database is locked"
            );
            competing.run("BEGIN IMMEDIATE");
            competing.run("ROLLBACK");
        } finally {
            competing.close(true);
            primary.close(true);
            await rm(directory, { force: true, recursive: true });
        }
    });

    test("creates a principal, credential, and grants without returning verifier material", async () => {
        const fixture = await openAutomationRepositoryFixture();

        try {
            const created = fixture.repository.withImmediateTransaction((unit) => {
                const principal = unit.insertPrincipalIfAvailable(
                    validAutomationPrincipalInsert
                );
                const credential = unit.insertCredentialIfAvailable(
                    validAutomationCredentialInsert
                );
                unit.insertCapabilities([
                    {
                        capability: "notifications:read",
                        grantedAt: securityCreatedAt,
                        principalId: automationPrincipalId,
                    },
                    {
                        capability: "reports:read",
                        grantedAt: securityCreatedAt,
                        principalId: automationPrincipalId,
                    },
                ]);
                return { credential, principal };
            });

            expect(created.principal).toMatchObject({
                authorizationVersion: 1,
                id: automationPrincipalId,
            });
            expect(created.credential?.id).toBe(validAutomationCredentialInsert.id);
            expect(fixture.repository.listCapabilities(automationPrincipalId)).toEqual([
                {
                    capability: "notifications:read",
                    grantedAt: securityCreatedAt,
                    principalId: automationPrincipalId,
                },
                {
                    capability: "reports:read",
                    grantedAt: securityCreatedAt,
                    principalId: automationPrincipalId,
                },
            ]);

            const returnedCredentials = [
                created.credential,
                fixture.repository.findCredential(
                    automationPrincipalId,
                    validAutomationCredentialInsert.id
                ),
                ...fixture.repository.listCredentials({
                    limit: 10,
                    principalId: automationPrincipalId,
                }),
            ].filter((credential) => credential !== undefined);
            expect(returnedCredentials).toHaveLength(3);
            for (const credential of returnedCredentials) {
                expect(Object.hasOwn(credential, "validatorHash")).toBeFalse();
            }
            expect(JSON.stringify(returnedCredentials)).not.toContain(
                validAutomationCredentialInsert.validatorHash
            );
        } finally {
            fixture.sqlite.close(true);
        }
    });

    test("paginates principals and credentials stably when timestamps match", async () => {
        const fixture = await openAutomationRepositoryFixture();
        const principalIds = ["pagination-a", "pagination-b", "pagination-c"];

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                for (const principalId of principalIds) {
                    expect(
                        unit.insertPrincipalIfAvailable({
                            ...validAutomationPrincipalInsert,
                            id: principalId,
                            label: principalId,
                        })
                    ).toBeDefined();
                }
                for (const [index, credentialId] of paginationCredentialIds.entries()) {
                    expect(
                        unit.insertCredentialIfAvailable({
                            ...validAutomationCredentialInsert,
                            id: credentialId,
                            prefix: indexedHex(index + 1, 32),
                            principalId: principalIds[0]!,
                            validatorHash: indexedHex(index + 1, 64),
                        })
                    ).toBeDefined();
                }
            });

            const firstPrincipalPage = fixture.repository.listPrincipals({ limit: 2 });
            expect(firstPrincipalPage.map((principal) => principal.id)).toEqual([
                "pagination-c",
                "pagination-b",
            ]);
            expect(
                fixture.repository
                    .listPrincipals({
                        beforeCreatedAt: firstPrincipalPage[1]!.createdAt,
                        beforeId: firstPrincipalPage[1]!.id,
                        limit: 2,
                    })
                    .map((principal) => principal.id)
            ).toEqual(["pagination-a"]);

            const firstCredentialPage = fixture.repository.listCredentials({
                limit: 2,
                principalId: principalIds[0]!,
            });
            expect(firstCredentialPage.map((credential) => credential.id)).toEqual([
                paginationCredentialIds[2],
                paginationCredentialIds[1],
            ]);
            expect(
                fixture.repository
                    .listCredentials({
                        beforeCreatedAt: firstCredentialPage[1]!.createdAt,
                        beforeId: firstCredentialPage[1]!.id,
                        limit: 2,
                        principalId: principalIds[0]!,
                    })
                    .map((credential) => credential.id)
            ).toEqual([paginationCredentialIds[0]]);
        } finally {
            fixture.sqlite.close(true);
        }
    });

    test("counts enabled principals and only currently active credentials", async () => {
        const fixture = await openAutomationRepositoryFixture();
        const checkedAt = addMinutes(securityCreatedAt, 10);

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPrincipalIfAvailable(validAutomationPrincipalInsert);
                unit.insertPrincipalIfAvailable({
                    ...validAutomationPrincipalInsert,
                    disabledAt: checkedAt,
                    id: "disabled-principal",
                    label: "Disabled principal",
                    updatedAt: checkedAt,
                });
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    id: activeCredentialId,
                    prefix: indexedHex(11, 32),
                    validatorHash: indexedHex(11, 64),
                });
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    expiresAt: addMinutes(securityCreatedAt, 5),
                    id: expiredCredentialId,
                    prefix: indexedHex(12, 32),
                    validatorHash: indexedHex(12, 64),
                });
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    id: revokedCredentialId,
                    prefix: indexedHex(13, 32),
                    revokedAt: addMinutes(securityCreatedAt, 5),
                    validatorHash: indexedHex(13, 64),
                });
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    createdAt: addMinutes(securityCreatedAt, 20),
                    id: futureCredentialId,
                    prefix: indexedHex(14, 32),
                    validatorHash: indexedHex(14, 64),
                });
            });

            expect(fixture.repository.countEnabledPrincipals()).toBe(1);
            expect(fixture.repository.countPrincipals()).toBe(2);
            expect(fixture.repository.countCredentials(automationPrincipalId)).toBe(4);
            expect(
                fixture.repository.countActiveCredentials(
                    automationPrincipalId,
                    checkedAt
                )
            ).toBe(1);
        } finally {
            fixture.sqlite.close(true);
        }
    });

    test("uses authorization-version CAS while preserving retained grant timestamps", async () => {
        const fixture = await openAutomationRepositoryFixture();
        const firstGrantedAt = addMilliseconds(securityCreatedAt, 1);
        const secondGrantedAt = addMilliseconds(securityCreatedAt, 2);

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPrincipalIfAvailable(validAutomationPrincipalInsert);
                expect(
                    unit.replaceCapabilities({
                        capabilities: ["notifications:read"],
                        expectedAuthorizationVersion: 1,
                        grantedAt: firstGrantedAt,
                        principalId: automationPrincipalId,
                    })?.authorizationVersion
                ).toBe(2);
                expect(
                    unit.replaceCapabilities({
                        capabilities: ["notifications:read", "reports:read"],
                        expectedAuthorizationVersion: 2,
                        grantedAt: secondGrantedAt,
                        principalId: automationPrincipalId,
                    })?.authorizationVersion
                ).toBe(3);
                expect(
                    unit.replaceCapabilities({
                        capabilities: ["reports:read"],
                        expectedAuthorizationVersion: 2,
                        grantedAt: addMilliseconds(securityCreatedAt, 3),
                        principalId: automationPrincipalId,
                    })
                ).toBeUndefined();
            });

            expect(fixture.repository.listCapabilities(automationPrincipalId)).toEqual([
                {
                    capability: "notifications:read",
                    grantedAt: firstGrantedAt,
                    principalId: automationPrincipalId,
                },
                {
                    capability: "reports:read",
                    grantedAt: secondGrantedAt,
                    principalId: automationPrincipalId,
                },
            ]);
            expect(
                fixture.repository.findPrincipal(automationPrincipalId)
                    ?.authorizationVersion
            ).toBe(3);
        } finally {
            fixture.sqlite.close(true);
        }
    });

    test("enforces one active staged replacement and revokes credentials idempotently", async () => {
        const fixture = await openAutomationRepositoryFixture();
        const firstRevokedAt = addMilliseconds(securityCreatedAt, 1);
        const laterRevocationAttempt = addMilliseconds(securityCreatedAt, 2);

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPrincipalIfAvailable(validAutomationPrincipalInsert);
                expect(
                    unit.insertCredentialIfAvailable(validAutomationCredentialInsert)
                ).toBeDefined();
                expect(
                    unit.insertCredentialIfAvailable({
                        ...validAutomationCredentialInsert,
                        id: firstReplacementId,
                        prefix: indexedHex(21, 32),
                        replacesCredentialId: validAutomationCredentialInsert.id,
                        validatorHash: indexedHex(21, 64),
                    })
                ).toBeDefined();
                expect(
                    unit.insertCredentialIfAvailable({
                        ...validAutomationCredentialInsert,
                        id: secondReplacementId,
                        prefix: indexedHex(22, 32),
                        replacesCredentialId: validAutomationCredentialInsert.id,
                        validatorHash: indexedHex(22, 64),
                    })
                ).toBeUndefined();

                expect(
                    unit.revokeCredential({
                        credentialId: firstReplacementId,
                        principalId: automationPrincipalId,
                        revokedAt: firstRevokedAt,
                    })?.revokedAt
                ).toEqual(firstRevokedAt);
                expect(
                    unit.revokeCredential({
                        credentialId: firstReplacementId,
                        principalId: automationPrincipalId,
                        revokedAt: laterRevocationAttempt,
                    })?.revokedAt
                ).toEqual(firstRevokedAt);
                expect(
                    unit.insertCredentialIfAvailable({
                        ...validAutomationCredentialInsert,
                        id: secondReplacementId,
                        prefix: indexedHex(22, 32),
                        replacesCredentialId: validAutomationCredentialInsert.id,
                        validatorHash: indexedHex(22, 64),
                    })
                ).toBeDefined();
            });

            expect(
                fixture.repository.findReplacement(
                    automationPrincipalId,
                    validAutomationCredentialInsert.id
                )?.id
            ).toBe(secondReplacementId);
        } finally {
            fixture.sqlite.close(true);
        }
    });

    test("disables a principal and revokes only its active credentials", async () => {
        const fixture = await openAutomationRepositoryFixture();
        const disabledAt = addMinutes(securityCreatedAt, 10);
        const earlierRevokedAt = addMinutes(securityCreatedAt, 3);

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPrincipalIfAvailable(validAutomationPrincipalInsert);
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    id: activeCredentialId,
                    prefix: indexedHex(31, 32),
                    validatorHash: indexedHex(31, 64),
                });
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    expiresAt: addMinutes(securityCreatedAt, 5),
                    id: expiredCredentialId,
                    prefix: indexedHex(32, 32),
                    validatorHash: indexedHex(32, 64),
                });
                unit.insertCredentialIfAvailable({
                    ...validAutomationCredentialInsert,
                    id: revokedCredentialId,
                    prefix: indexedHex(33, 32),
                    revokedAt: earlierRevokedAt,
                    validatorHash: indexedHex(33, 64),
                });

                expect(
                    unit.disablePrincipal({
                        disabledAt,
                        expectedAuthorizationVersion: 1,
                        principalId: automationPrincipalId,
                    })
                ).toMatchObject({ authorizationVersion: 2, disabledAt });
                expect(
                    unit.revokeActiveCredentials(automationPrincipalId, disabledAt)
                ).toBe(1);
                expect(
                    unit.revokeActiveCredentials(automationPrincipalId, disabledAt)
                ).toBe(0);
            });

            expect(fixture.repository.countEnabledPrincipals()).toBe(0);
            expect(
                fixture.repository.findCredential(
                    automationPrincipalId,
                    activeCredentialId
                )?.revokedAt
            ).toEqual(disabledAt);
            expect(
                fixture.repository.findCredential(
                    automationPrincipalId,
                    expiredCredentialId
                )?.revokedAt
            ).toBeNull();
            expect(
                fixture.repository.findCredential(
                    automationPrincipalId,
                    revokedCredentialId
                )?.revokedAt
            ).toEqual(earlierRevokedAt);
            expect(
                fixture.repository.countActiveCredentials(
                    automationPrincipalId,
                    disabledAt
                )
            ).toBe(0);
        } finally {
            fixture.sqlite.close(true);
        }
    });

    test("rolls principal and audit writes back when credential insertion collides", async () => {
        const fixture = await openAutomationRepositoryFixture();
        const collidingPrincipalId = "collision-target";

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPrincipalIfAvailable(validAutomationPrincipalInsert);
                unit.insertCredentialIfAvailable(validAutomationCredentialInsert);
            });

            expect(() =>
                fixture.repository.withImmediateTransaction((unit) => {
                    unit.insertAuditEvent(validAuditEventInsert);
                    expect(
                        unit.insertPrincipalIfAvailable({
                            ...validAutomationPrincipalInsert,
                            id: collidingPrincipalId,
                            label: "Collision target",
                        })
                    ).toBeDefined();
                    expect(
                        unit.insertCredentialIfAvailable({
                            ...validAutomationCredentialInsert,
                            id: collidingCredentialId,
                            principalId: collidingPrincipalId,
                        })
                    ).toBeUndefined();
                    throw new Error("forced automation credential collision rollback");
                })
            ).toThrow("forced automation credential collision rollback");

            expect(
                fixture.repository.findPrincipal(collidingPrincipalId)
            ).toBeUndefined();
            expect(
                fixture.sqlite
                    .query<{ count: number }, [string]>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE id = ?
                    `)
                    .get(auditEventId)
            ).toEqual({ count: 0 });
            expect(
                fixture.repository.findCredential(
                    automationPrincipalId,
                    validAutomationCredentialInsert.id
                )
            ).toBeDefined();
        } finally {
            fixture.sqlite.close(true);
        }
    });
});
