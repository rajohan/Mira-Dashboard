import { describe, expect, test } from "bun:test";

import { addMinutes, subMinutes } from "date-fns";

import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import {
    validAuthPendingLoginInsert,
    validAuthSessionInsert,
} from "../../../database/validation/testSupport/securityRows.ts";
import { parseDashboardRecoveryCode } from "./recoveryCodes.ts";
import {
    accountLifecycleMetadata,
    accountLifecycleNow,
    accountLifecycleUserId,
    createAccountLifecycleHarness,
    enableAccountMfa,
} from "./testSupport/accountLifecycle.ts";

describe("MFA account maintenance lifecycle", () => {
    test("rotates recovery state and disables MFA with full account cleanup", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const enabled = await enableAccountMfa(harness);
            const oldRecoveryCode = parseDashboardRecoveryCode(
                enabled.confirmed.recoveryCodes[0]
            );
            if (oldRecoveryCode === undefined) {
                throw new Error("Expected canonical initial recovery code");
            }
            const rotatedCodes = await harness.service.rotateRecoveryCodes(
                enabled.identity,
                accountLifecycleMetadata("rotate-recovery")
            );
            if (rotatedCodes.status !== "rotated") {
                throw new Error(
                    `Expected recovery rotation, received ${rotatedCodes.status}`
                );
            }
            expect(rotatedCodes.recoveryCodes).toHaveLength(recoveryCodeCount);
            expect(rotatedCodes.recoveryCodes).not.toEqual(
                enabled.confirmed.recoveryCodes
            );
            expect(
                harness.repository.findRecoveryCode(
                    accountLifecycleUserId,
                    oldRecoveryCode.selector
                )
            ).toBeUndefined();
            expect(
                harness.repository.countUnusedRecoveryCodes(accountLifecycleUserId)
            ).toBe(recoveryCodeCount);

            const pending = await harness.service.beginTotpEnrollment(
                enabled.identity,
                { label: "Pending authenticator" },
                accountLifecycleMetadata("begin-pending-before-disable")
            );
            expect(pending.status).toBe("created");
            harness.repository.withImmediateTransaction((unit) => {
                unit.insertSession({
                    ...validAuthSessionInsert,
                    authenticatedAt: subMinutes(accountLifecycleNow, 5),
                    authenticationVersion: 2,
                    authMethod: "totp",
                    createdAt: accountLifecycleNow,
                    expiresAt: addMinutes(accountLifecycleNow, 30),
                    id: "7".repeat(32),
                    lastSeenAt: accountLifecycleNow,
                    mfaVerifiedAt: accountLifecycleNow,
                    passwordVerifiedAt: accountLifecycleNow,
                    validatorHash: "6".repeat(64),
                });
                unit.insertPendingLogin({
                    ...validAuthPendingLoginInsert,
                    authenticationVersion: 2,
                    createdAt: accountLifecycleNow,
                    expiresAt: addMinutes(accountLifecycleNow, 5),
                    id: "9".repeat(32),
                    passwordVerifiedAt: accountLifecycleNow,
                    replacedSessionId: enabled.identity.sessionId,
                    validatorHash: "8".repeat(64),
                });
            });

            const disabled = await harness.service.disableMfa(
                enabled.identity,
                { password: "correct-password-1" },
                accountLifecycleMetadata("disable-mfa")
            );
            if (disabled.status !== "disabled") {
                throw new Error(`Expected MFA disablement, received ${disabled.status}`);
            }
            const disabledIdentity = {
                sessionId: disabled.session.id,
                userId: accountLifecycleUserId,
            };
            expect(disabled.revokedSessions).toBe(1);
            expect(harness.repository.findUserById(accountLifecycleUserId)).toMatchObject(
                {
                    authenticationVersion: 3,
                    mfaEnabledAt: null,
                }
            );
            expect(harness.repository.countTotpFactors(accountLifecycleUserId)).toBe(0);
            expect(
                harness.repository.listRecoveryCodes(accountLifecycleUserId, 1)
            ).toEqual([]);
            expect(harness.repository.findPendingLogin("9".repeat(32))).toBeUndefined();
            expect(
                harness.repository.findSession(
                    accountLifecycleUserId,
                    enabled.identity.sessionId
                )
            ).toBeUndefined();
            expect(
                harness.repository.findSession(accountLifecycleUserId, "7".repeat(32))
            ).toBeUndefined();
            expect(harness.service.summary(disabledIdentity)).toMatchObject({
                status: "found",
                summary: {
                    mfa: {
                        enabled: false,
                        recoveryCodesRemaining: 0,
                        totpFactors: [],
                    },
                    recentAuth: { mfa: { recent: false }, password: { recent: true } },
                },
            });
            expect(harness.maximumConcurrentRecoveryHashes()).toBe(1);
            expect(harness.consumedWorkUnits).toEqual([
                recoveryCodeCount,
                recoveryCodeCount,
                1,
            ]);
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });
});
