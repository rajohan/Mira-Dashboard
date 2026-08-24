import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { addMinutes } from "date-fns";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import { users } from "../../../database/schema/users.ts";
import {
    auditEventId,
    pendingLoginSelector,
    recoveryCodeId,
    recoveryCodeSelector,
    securityCreatedAt,
    securityUpdatedAt,
    securityUserId,
    sessionSelector,
    validAuditEventInsert,
    validAuthPendingLoginInsert,
    validAuthSessionInsert,
    validUserInsert,
    validUserRecoveryCodeInsert,
    validUserTotpFactorInsert,
} from "../../../database/validation/testSupport/securityRows.ts";
import { userInsertSchema } from "../../../database/validation/users.ts";
import { testImmediateDatabaseWriteAdmission } from "../../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import {
    createMfaLifecycleRepository,
    pendingLoginAttemptMaximum,
} from "./lifecycleRepository.ts";

const initialTotpStep = 100;
const nextTotpStep = initialTotpStep + 1;
const checkedAt = addMinutes(securityCreatedAt, 2);
const rateLimitBucketKey = "e".repeat(64);
const replacementSessionId = "f".repeat(32);
const replacementSessionValidatorHash = "9".repeat(64);
const exhaustedPendingLoginId = "e".repeat(32);
const exhaustedPendingLoginValidatorHash = "f".repeat(64);

async function openMfaRepositoryFixture() {
    const database = await openFreshMigratedDatabase();
    const repository = createMfaLifecycleRepository(
        database.orm,
        testImmediateDatabaseWriteAdmission
    );

    try {
        database.orm
            .insert(users)
            .values(
                v.parse(userInsertSchema, {
                    ...validUserInsert,
                    mfaEnabledAt: securityUpdatedAt,
                })
            )
            .run();
        await repository.withImmediateTransaction((unit) => {
            unit.insertSession(validAuthSessionInsert);
            unit.insertPendingLogin(validAuthPendingLoginInsert);
            unit.insertTotpFactor({
                ...validUserTotpFactorInsert,
                confirmedAt: securityUpdatedAt,
                lastUsedStep: initialTotpStep,
            });
            unit.insertRecoveryCode(validUserRecoveryCodeInsert);
            unit.upsertRateLimitBucket({
                blockedUntil: null,
                bucketKey: rateLimitBucketKey,
                failureCount: 2,
                firstFailedAt: securityCreatedAt,
                kind: "login-mfa-source",
                updatedAt: securityUpdatedAt,
            });
        });
        return { database, repository };
    } catch (error) {
        database.sqlite.close(true);
        throw error;
    }
}

describe("MFA lifecycle repository", () => {
    test("runs callbacks synchronously after acquiring the SQLite immediate write lock", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-mfa-repository-"));
        const databasePath = path.join(directory, "dashboard.sqlite");
        const primary = new Database(databasePath, { create: true, strict: true });
        const competing = new Database(databasePath, { strict: true });
        competing.run("PRAGMA busy_timeout = 0");
        const repository = createMfaLifecycleRepository(
            drizzle({ client: primary }),
            testImmediateDatabaseWriteAdmission
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
            const result = await repository.withImmediateTransaction(() => {
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

    test("rolls proof, pending-login, session, audit, and rate state back when the callback throws", async () => {
        const fixture = await openMfaRepositoryFixture();

        try {
            expect(
                fixture.repository.withImmediateTransaction((unit) => {
                    expect(
                        unit.advanceTotpLastUsedStep({
                            expectedConfirmedAt: securityUpdatedAt,
                            expectedEncryptedSecret:
                                validUserTotpFactorInsert.encryptedSecret,
                            expectedLastUsedStep: initialTotpStep,
                            expectedSecretKeyId: validUserTotpFactorInsert.secretKeyId,
                            factorId: validUserTotpFactorInsert.id,
                            lastUsedStep: nextTotpStep,
                            userId: securityUserId,
                        })
                    ).toBeDefined();
                    expect(
                        unit.consumeRecoveryCode({
                            codeId: recoveryCodeId,
                            expectedCreatedAt: securityCreatedAt,
                            expectedValidatorHash:
                                validUserRecoveryCodeInsert.validatorHash,
                            selector: recoveryCodeSelector,
                            usedAt: checkedAt,
                            userId: securityUserId,
                        })
                    ).toBeDefined();
                    expect(
                        unit.consumePendingLogin({
                            authenticationVersion: 1,
                            checkedAt,
                            id: pendingLoginSelector,
                            method: "totp",
                            userId: securityUserId,
                            validatorHash: validAuthPendingLoginInsert.validatorHash,
                        })
                    ).toBeDefined();
                    expect(
                        unit.deleteSession(securityUserId, sessionSelector)
                    ).toBeDefined();
                    unit.insertSession({
                        ...validAuthSessionInsert,
                        authenticatedAt: securityCreatedAt,
                        authMethod: "totp",
                        createdAt: checkedAt,
                        id: replacementSessionId,
                        lastSeenAt: checkedAt,
                        mfaVerifiedAt: checkedAt,
                        validatorHash: replacementSessionValidatorHash,
                    });
                    unit.insertAuditEvent(validAuditEventInsert);
                    unit.deleteRateLimitBucket(rateLimitBucketKey);
                    throw new Error("forced MFA repository rollback");
                })
            ).rejects.toThrow("forced MFA repository rollback");

            expect(
                fixture.repository.findTotpFactor(
                    securityUserId,
                    validUserTotpFactorInsert.id
                )?.lastUsedStep
            ).toBe(initialTotpStep);
            expect(
                fixture.repository.findRecoveryCode(securityUserId, recoveryCodeSelector)
                    ?.usedAt
            ).toBeNull();
            expect(
                fixture.repository.findPendingLogin(pendingLoginSelector)
            ).toMatchObject({ attemptCount: 0 });
            expect(
                fixture.repository.findSession(securityUserId, sessionSelector)
            ).toBeDefined();
            expect(
                fixture.repository.findSession(securityUserId, replacementSessionId)
            ).toBeUndefined();
            expect(
                fixture.database.sqlite
                    .query<{ count: number }, [string]>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE id = ?
                    `)
                    .get(auditEventId)
            ).toEqual({ count: 0 });
            expect(
                fixture.repository.findRateLimitBucket(rateLimitBucketKey)
            ).toMatchObject({ failureCount: 2 });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("allows one stale-state winner for TOTP steps and recovery codes", async () => {
        const fixture = await openMfaRepositoryFixture();

        try {
            const advanceInput = {
                expectedConfirmedAt: securityUpdatedAt,
                expectedEncryptedSecret: validUserTotpFactorInsert.encryptedSecret,
                expectedLastUsedStep: initialTotpStep,
                expectedSecretKeyId: validUserTotpFactorInsert.secretKeyId,
                factorId: validUserTotpFactorInsert.id,
                lastUsedStep: nextTotpStep,
                userId: securityUserId,
            };
            const stepContenders = [
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceTotpLastUsedStep(advanceInput)
                ),
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceTotpLastUsedStep(advanceInput)
                ),
            ];

            expect(stepContenders[0]?.lastUsedStep).toBe(nextTotpStep);
            expect(stepContenders[1]).toBeUndefined();
            expect(
                fixture.repository.findTotpFactor(
                    securityUserId,
                    validUserTotpFactorInsert.id
                )?.lastUsedStep
            ).toBe(nextTotpStep);

            const consumeInput = {
                codeId: recoveryCodeId,
                expectedCreatedAt: securityCreatedAt,
                expectedValidatorHash: validUserRecoveryCodeInsert.validatorHash,
                selector: recoveryCodeSelector,
                usedAt: checkedAt,
                userId: securityUserId,
            };
            const recoveryContenders = [
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumeRecoveryCode(consumeInput)
                ),
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumeRecoveryCode(consumeInput)
                ),
            ];

            expect(recoveryContenders[0]?.usedAt).toEqual(checkedAt);
            expect(recoveryContenders[1]).toBeUndefined();
            expect(
                fixture.repository.findRecoveryCode(securityUserId, recoveryCodeSelector)
                    ?.usedAt
            ).toEqual(checkedAt);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("allows one pending-login consumer and one final failed-attempt winner", async () => {
        const fixture = await openMfaRepositoryFixture();

        try {
            const consumeInput = {
                authenticationVersion: 1,
                checkedAt,
                id: pendingLoginSelector,
                method: "recovery" as const,
                userId: securityUserId,
                validatorHash: validAuthPendingLoginInsert.validatorHash,
            };
            const consumptionContenders = [
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumePendingLogin(consumeInput)
                ),
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumePendingLogin(consumeInput)
                ),
            ];

            expect(consumptionContenders[0]?.id).toBe(pendingLoginSelector);
            expect(consumptionContenders[1]).toBeUndefined();
            expect(
                fixture.repository.findPendingLogin(pendingLoginSelector)
            ).toBeUndefined();

            await fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPendingLogin({
                    ...validAuthPendingLoginInsert,
                    id: exhaustedPendingLoginId,
                    validatorHash: exhaustedPendingLoginValidatorHash,
                });
            });
            const incrementInput = {
                authenticationVersion: 1,
                failedAt: checkedAt,
                id: exhaustedPendingLoginId,
                userId: securityUserId,
                validatorHash: exhaustedPendingLoginValidatorHash,
            };
            for (let attempt = 1; attempt < pendingLoginAttemptMaximum; attempt += 1) {
                const incremented = await fixture.repository.withImmediateTransaction(
                    (unit) => unit.incrementPendingLoginAttempt(incrementInput)
                );
                expect(incremented?.attemptCount).toBe(attempt);
            }
            const finalAttemptContenders = [
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.incrementPendingLoginAttempt(incrementInput)
                ),
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.incrementPendingLoginAttempt(incrementInput)
                ),
            ];

            expect(finalAttemptContenders[0]?.attemptCount).toBe(
                pendingLoginAttemptMaximum
            );
            expect(finalAttemptContenders[1]).toBeUndefined();
            expect(
                await fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumePendingLogin({
                        ...consumeInput,
                        id: exhaustedPendingLoginId,
                        validatorHash: exhaustedPendingLoginValidatorHash,
                    })
                )
            ).toBeUndefined();
            expect(
                fixture.repository.findPendingLogin(exhaustedPendingLoginId)?.attemptCount
            ).toBe(pendingLoginAttemptMaximum);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
