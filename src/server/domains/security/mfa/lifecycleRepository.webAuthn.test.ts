import { describe, expect, test } from "bun:test";

import { addMilliseconds, addMinutes, subMilliseconds } from "date-fns";
import * as v from "valibot";

import { users } from "../../../database/schema/users.ts";
import {
    pendingLoginSelector,
    securityUpdatedAt,
    securityUserId,
    validAuthChallengeInsert,
    validAuthPendingLoginInsert,
    validAuthSessionInsert,
    validUserInsert,
    validUserWebAuthnCredentialInsert,
    webAuthnExternalCredentialId,
} from "../../../database/validation/testSupport/securityRows.ts";
import { userInsertSchema } from "../../../database/validation/users.ts";
import { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import { createMfaLifecycleRepository } from "./lifecycleRepository.ts";
import type {
    AdvanceWebAuthnCredentialInput,
    MfaWebAuthnChallengeInsert,
    MfaWebAuthnCredentialRecord,
} from "./lifecycleRepositoryTypes.ts";

const replacementChallengeId = "019fc968-1a9b-7780-8f1b-d5b863b0e7b4";
const stepUpChallengeId = "019fc968-1a9b-7781-9f1b-d5b863b0e7b4";
const pendingLoginChallengeId = "019fc968-1a9b-7782-af1b-d5b863b0e7b4";
const secondCredentialId = "019fc968-1a9b-7783-bf1b-d5b863b0e7b4";
const webAuthnDisabledPendingLoginId = "f".repeat(32);
const webAuthnDisabledPendingLoginValidatorHash = "1".repeat(64);
const firstUsedAt = addMilliseconds(securityUpdatedAt, 1);
const secondUsedAt = addMilliseconds(firstUsedAt, 1);
const thirdUsedAt = addMilliseconds(secondUsedAt, 1);

async function openWebAuthnRepositoryFixture() {
    const database = await openFreshMigratedDatabase();
    const repository = createMfaLifecycleRepository(database.orm);

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
        repository.withImmediateTransaction((unit) => {
            unit.insertSession(validAuthSessionInsert);
            unit.insertPendingLogin({
                ...validAuthPendingLoginInsert,
                allowsWebAuthn: true,
            });
        });
        return { database, repository };
    } catch (error) {
        database.sqlite.close(true);
        throw error;
    }
}

function registrationChallenge(
    replacements: Partial<MfaWebAuthnChallengeInsert> = {}
): MfaWebAuthnChallengeInsert {
    return { ...validAuthChallengeInsert, ...replacements };
}

function advanceCredentialInput(
    credential: MfaWebAuthnCredentialRecord,
    replacements: Partial<AdvanceWebAuthnCredentialInput> = {}
): AdvanceWebAuthnCredentialInput {
    return {
        backedUp: credential.backedUp,
        counter: credential.counter,
        credentialId: credential.credentialId,
        deviceType: credential.deviceType,
        expectedBackedUp: credential.backedUp,
        expectedCounter: credential.counter,
        expectedCreatedAt: credential.createdAt,
        expectedDeviceType: credential.deviceType,
        expectedLastUsedAt: credential.lastUsedAt,
        expectedPublicKey: credential.publicKey,
        expectedRpId: credential.rpId,
        id: credential.id,
        usedAt: firstUsedAt,
        userId: credential.userId,
        ...replacements,
    };
}

describe("MFA lifecycle WebAuthn repository", () => {
    test("replaces and consumes both session- and pending-login-bound challenges", async () => {
        const fixture = await openWebAuthnRepositoryFixture();

        try {
            const initial = fixture.repository.withImmediateTransaction((unit) =>
                unit.replaceWebAuthnChallenge(registrationChallenge())
            );
            expect(
                fixture.repository.findSessionWebAuthnChallenge(
                    validAuthSessionInsert.id,
                    "registration"
                )
            ).toEqual(initial);

            const replacement = fixture.repository.withImmediateTransaction((unit) =>
                unit.replaceWebAuthnChallenge(
                    registrationChallenge({
                        challenge: "B".repeat(32),
                        id: replacementChallengeId,
                    })
                )
            );
            expect(
                fixture.repository.findSessionWebAuthnChallenge(
                    validAuthSessionInsert.id,
                    "registration"
                )
            ).toEqual(replacement);
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumeWebAuthnChallenge({
                        ...initial,
                        checkedAt: addMinutes(initial.createdAt, 1),
                    })
                )
            ).toBeUndefined();

            const stepUp = fixture.repository.withImmediateTransaction((unit) =>
                unit.replaceWebAuthnChallenge(
                    registrationChallenge({
                        challenge: "C".repeat(32),
                        id: stepUpChallengeId,
                        purpose: "step-up",
                    })
                )
            );
            const pendingLogin = fixture.repository.withImmediateTransaction((unit) =>
                unit.replaceWebAuthnChallenge(
                    registrationChallenge({
                        challenge: "D".repeat(32),
                        id: pendingLoginChallengeId,
                        pendingLoginId: pendingLoginSelector,
                        purpose: "login",
                        sessionId: null,
                    })
                )
            );

            expect(
                fixture.repository.findSessionWebAuthnChallenge(
                    validAuthSessionInsert.id,
                    "step-up"
                )
            ).toEqual(stepUp);
            expect(
                fixture.repository.findPendingLoginWebAuthnChallenge(pendingLoginSelector)
            ).toEqual(pendingLogin);

            for (const invalidSnapshot of [
                {
                    ...pendingLogin,
                    checkedAt: addMinutes(pendingLogin.createdAt, 1),
                    configFingerprint: "a".repeat(64),
                },
                {
                    ...pendingLogin,
                    checkedAt: subMilliseconds(pendingLogin.createdAt, 1),
                },
                { ...pendingLogin, checkedAt: pendingLogin.expiresAt },
            ]) {
                expect(
                    fixture.repository.withImmediateTransaction((unit) =>
                        unit.consumeWebAuthnChallenge(invalidSnapshot)
                    )
                ).toBeUndefined();
            }
            expect(
                fixture.repository.findPendingLoginWebAuthnChallenge(pendingLoginSelector)
            ).toEqual(pendingLogin);

            const consumeInput = {
                ...pendingLogin,
                checkedAt: addMinutes(pendingLogin.createdAt, 1),
            };
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumeWebAuthnChallenge(consumeInput)
                )
            ).toEqual(pendingLogin);
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumeWebAuthnChallenge(consumeInput)
                )
            ).toBeUndefined();
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("persists credential lookup and permits one CAS winner for every counter model", async () => {
        const fixture = await openWebAuthnRepositoryFixture();

        try {
            const inserted = fixture.repository.withImmediateTransaction((unit) =>
                unit.insertWebAuthnCredentialIfAvailable(
                    validUserWebAuthnCredentialInsert
                )
            );
            if (!inserted) throw new Error("Expected available WebAuthn credential");
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.insertWebAuthnCredentialIfAvailable({
                        ...validUserWebAuthnCredentialInsert,
                        id: secondCredentialId,
                    })
                )
            ).toBeUndefined();
            expect(fixture.repository.countWebAuthnCredentials(securityUserId)).toBe(1);
            expect(
                fixture.repository.findWebAuthnCredential(
                    securityUserId,
                    webAuthnExternalCredentialId
                )
            ).toEqual(inserted);
            expect(
                fixture.repository.findWebAuthnCredentialById(
                    securityUserId,
                    validUserWebAuthnCredentialInsert.id
                )
            ).toEqual(inserted);
            expect(fixture.repository.listWebAuthnCredentials(securityUserId, 1)).toEqual(
                [inserted]
            );

            const firstZeroCounterInput = advanceCredentialInput(inserted);
            const firstZeroCounter = fixture.repository.withImmediateTransaction((unit) =>
                unit.advanceWebAuthnCredential(firstZeroCounterInput)
            );
            expect(firstZeroCounter?.lastUsedAt).toEqual(firstUsedAt);
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceWebAuthnCredential(firstZeroCounterInput)
                )
            ).toBeUndefined();
            if (!firstZeroCounter) throw new Error("Expected zero-counter CAS winner");

            expect(() =>
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceWebAuthnCredential(
                        advanceCredentialInput(firstZeroCounter, {
                            usedAt: firstUsedAt,
                        })
                    )
                )
            ).toThrow("WebAuthn credential transition is invalid");
            const secondZeroCounter = fixture.repository.withImmediateTransaction(
                (unit) =>
                    unit.advanceWebAuthnCredential(
                        advanceCredentialInput(firstZeroCounter, {
                            usedAt: secondUsedAt,
                        })
                    )
            );
            expect(secondZeroCounter?.lastUsedAt).toEqual(secondUsedAt);
            if (!secondZeroCounter)
                throw new Error("Expected second zero-counter CAS winner");

            const monotonic = fixture.repository.withImmediateTransaction((unit) =>
                unit.advanceWebAuthnCredential(
                    advanceCredentialInput(secondZeroCounter, {
                        counter: 1,
                        usedAt: secondUsedAt,
                    })
                )
            );
            expect(monotonic).toMatchObject({ counter: 1, lastUsedAt: secondUsedAt });
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceWebAuthnCredential(
                        advanceCredentialInput(secondZeroCounter, {
                            counter: 1,
                            usedAt: secondUsedAt,
                        })
                    )
                )
            ).toBeUndefined();
            expect(() =>
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceWebAuthnCredential(
                        advanceCredentialInput(monotonic ?? secondZeroCounter, {
                            counter: 1,
                            usedAt: thirdUsedAt,
                        })
                    )
                )
            ).toThrow("WebAuthn credential transition is invalid");
            expect(() =>
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.advanceWebAuthnCredential(
                        advanceCredentialInput(secondZeroCounter, {
                            deviceType:
                                secondZeroCounter.deviceType === "multiDevice"
                                    ? "singleDevice"
                                    : "multiDevice",
                            usedAt: thirdUsedAt,
                        })
                    )
                )
            ).toThrow("WebAuthn credential transition is invalid");
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("requires WebAuthn eligibility when consuming a pending login", async () => {
        const fixture = await openWebAuthnRepositoryFixture();

        try {
            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertPendingLogin({
                    ...validAuthPendingLoginInsert,
                    allowsWebAuthn: false,
                    id: webAuthnDisabledPendingLoginId,
                    validatorHash: webAuthnDisabledPendingLoginValidatorHash,
                });
            });
            const enabledInput = {
                authenticationVersion: 1,
                checkedAt: securityUpdatedAt,
                id: pendingLoginSelector,
                method: "webauthn" as const,
                userId: securityUserId,
                validatorHash: validAuthPendingLoginInsert.validatorHash,
            };
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumePendingLogin(enabledInput)
                )?.id
            ).toBe(pendingLoginSelector);
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumePendingLogin(enabledInput)
                )
            ).toBeUndefined();

            const disabledInput = {
                ...enabledInput,
                id: webAuthnDisabledPendingLoginId,
                validatorHash: webAuthnDisabledPendingLoginValidatorHash,
            };
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.consumePendingLogin(disabledInput)
                )
            ).toBeUndefined();
            expect(
                fixture.repository.findPendingLogin(webAuthnDisabledPendingLoginId)?.id
            ).toBe(webAuthnDisabledPendingLoginId);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("isolates credential deletes and rolls challenge and credential writes back together", async () => {
        const fixture = await openWebAuthnRepositoryFixture();

        try {
            expect(() =>
                fixture.repository.withImmediateTransaction((unit) => {
                    unit.replaceWebAuthnChallenge(registrationChallenge());
                    unit.insertWebAuthnCredential(validUserWebAuthnCredentialInsert);
                    throw new Error("forced WebAuthn repository rollback");
                })
            ).toThrow("forced WebAuthn repository rollback");
            expect(
                fixture.repository.findSessionWebAuthnChallenge(
                    validAuthSessionInsert.id,
                    "registration"
                )
            ).toBeUndefined();
            expect(fixture.repository.countWebAuthnCredentials(securityUserId)).toBe(0);

            fixture.repository.withImmediateTransaction((unit) => {
                unit.insertWebAuthnCredential(validUserWebAuthnCredentialInsert);
                unit.insertWebAuthnCredential({
                    ...validUserWebAuthnCredentialInsert,
                    credentialId: `${webAuthnExternalCredentialId.slice(0, -1)}A`,
                    id: secondCredentialId,
                    label: "Backup security key",
                });
            });
            expect(fixture.repository.countWebAuthnCredentials(securityUserId)).toBe(2);
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.deleteWebAuthnCredential(securityUserId, secondCredentialId)
                )?.id
            ).toBe(secondCredentialId);
            expect(
                fixture.repository.withImmediateTransaction((unit) =>
                    unit.deleteWebAuthnCredentialsForUser(securityUserId)
                )
            ).toBe(1);
            expect(fixture.repository.countWebAuthnCredentials(securityUserId)).toBe(0);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
