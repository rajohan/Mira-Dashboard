import { describe, expect, test } from "bun:test";

import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import { createTestAuthenticationWorkGate } from "../../../test/support/authenticationWorkGate.ts";
import { rateLimitBucketKey } from "../authenticationRateLimit.ts";
import {
    accountLifecycleMetadata,
    accountLifecycleUserId,
    createAccountLifecycleBarrier,
    createAccountLifecycleHarness,
    enableAccountMfa,
} from "./testSupport/accountLifecycle.ts";

describe("MFA account proof lifecycle", () => {
    test("consumes possession proofs once and rotates password reauthentication", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const enabled = await enableAccountMfa(harness);
            let identity = enabled.identity;
            const recoveryCode = enabled.confirmed.recoveryCodes[0]!;

            const recoveryStepUp = await harness.service.stepUpRecovery(
                identity,
                { code: recoveryCode },
                accountLifecycleMetadata("recovery-step-up")
            );
            if (recoveryStepUp.status !== "verified") {
                throw new Error(
                    `Expected recovery step-up, received ${recoveryStepUp.status}`
                );
            }
            identity = {
                sessionId: recoveryStepUp.session.id,
                userId: accountLifecycleUserId,
            };
            expect(recoveryStepUp.recoveryCodesRemaining).toBe(recoveryCodeCount - 1);
            expect(
                await harness.service.stepUpRecovery(
                    identity,
                    { code: recoveryCode },
                    accountLifecycleMetadata("recovery-replay")
                )
            ).toEqual({ status: "invalid-proof" });

            const totpStepUp = await harness.service.stepUpTotp(
                identity,
                { code: "123456" },
                accountLifecycleMetadata("totp-step-up")
            );
            if (totpStepUp.status !== "verified") {
                throw new Error(`Expected TOTP step-up, received ${totpStepUp.status}`);
            }
            identity = {
                sessionId: totpStepUp.session.id,
                userId: accountLifecycleUserId,
            };
            expect(
                harness.repository.findTotpFactor(
                    accountLifecycleUserId,
                    enabled.factorId
                )?.lastUsedStep
            ).toBe(102);
            expect(
                await harness.service.reauthenticatePassword(
                    identity,
                    { password: "wrong-password-1" },
                    accountLifecycleMetadata("wrong-password-reauthentication")
                )
            ).toEqual({ status: "invalid-password" });

            const passwordReauthentication = await harness.service.reauthenticatePassword(
                identity,
                { password: "correct-password-1" },
                accountLifecycleMetadata("password-reauthentication")
            );
            if (passwordReauthentication.status !== "verified") {
                throw new Error(
                    `Expected password reauthentication, received ${passwordReauthentication.status}`
                );
            }
            identity = {
                sessionId: passwordReauthentication.session.id,
                userId: accountLifecycleUserId,
            };
            expect(passwordReauthentication.session.authMethod).toBe("password");
            expect(harness.service.summary(identity)).toMatchObject({
                status: "found",
                summary: {
                    mfa: { enabled: true, recoveryCodesRemaining: recoveryCodeCount - 1 },
                    recentAuth: { mfa: { recent: true }, password: { recent: true } },
                },
            });
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });

    test("commits password cooldown before admitting queued verification", async () => {
        const harness = await createAccountLifecycleHarness({
            passwordWorkGate: createTestAuthenticationWorkGate(1, 16),
        });
        try {
            const enabled = await enableAccountMfa(harness);
            const participants = 6;

            const results = await Promise.all(
                Array.from({ length: participants }, (_, index) =>
                    harness.service.reauthenticatePassword(
                        enabled.identity,
                        { password: "wrong-password-1" },
                        accountLifecycleMetadata(`queued-password-${index}`)
                    )
                )
            );

            expect(harness.passwordVerificationCalls()).toBe(3);
            expect(
                results.filter(({ status }) => status === "invalid-password")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-password", accountLifecycleUserId)
                )
            ).toMatchObject({ failureCount: 3, kind: "account-password" });
        } finally {
            harness.close();
        }
    });

    test("commits TOTP cooldown before admitting queued decryption", async () => {
        const harness = await createAccountLifecycleHarness({
            totpWorkGate: createTestAuthenticationWorkGate(1, 16),
        });
        try {
            const enabled = await enableAccountMfa(harness);
            const initialDecryptions = harness.totpDecryptionCalls();
            const participants = 6;

            const results = await Promise.all(
                Array.from({ length: participants }, (_, index) =>
                    harness.service.stepUpTotp(
                        enabled.identity,
                        { code: "000000" },
                        accountLifecycleMetadata(`queued-totp-${index}`)
                    )
                )
            );

            expect(harness.totpDecryptionCalls() - initialDecryptions).toBe(3);
            expect(
                results.filter(({ status }) => status === "invalid-proof")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-mfa", accountLifecycleUserId)
                )
            ).toMatchObject({ failureCount: 3, kind: "account-mfa" });
        } finally {
            harness.close();
        }
    });

    test("serializes concurrent TOTP step-up failures at the source threshold", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const enabled = await enableAccountMfa(harness);
            const participants = 6;
            const barrier = createAccountLifecycleBarrier(participants);
            harness.setBeforeTotpVerification((token) =>
                token === "000000" ? barrier.wait() : Promise.resolve()
            );

            const results = await Promise.all(
                Array.from({ length: participants }, (_, index) =>
                    harness.service.stepUpTotp(
                        enabled.identity,
                        { code: "000000" },
                        accountLifecycleMetadata(`concurrent-step-up-${index}`)
                    )
                )
            );

            expect(barrier.arrivals()).toBe(participants);
            expect(
                results.filter(({ status }) => status === "invalid-proof")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-mfa", accountLifecycleUserId)
                )
            ).toMatchObject({ failureCount: 3, kind: "account-mfa" });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.mfa.step-up'
                          AND outcome = 'denied'
                    `)
                    .get()
            ).toEqual({ count: 3 });
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });

    test("accounts for wrong proofs when another TOTP factor is unavailable", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const enabled = await enableAccountMfa(harness);
            await harness.insertUnavailableTotpFactor();
            const initialDecryptionCalls = harness.totpDecryptionCalls();

            const results = [];
            for (let index = 0; index < 3; index += 1) {
                results.push(
                    await harness.service.stepUpTotp(
                        enabled.identity,
                        { code: "000000" },
                        accountLifecycleMetadata(`unavailable-factor-${index}`)
                    )
                );
            }

            expect(results.map(({ status }) => status)).toEqual([
                "service-unavailable",
                "service-unavailable",
                "rate-limited",
            ]);
            expect(harness.totpDecryptionCalls() - initialDecryptionCalls).toBe(6);
            const decryptionCallsAtBlock = harness.totpDecryptionCalls();
            expect(
                await harness.service.stepUpTotp(
                    enabled.identity,
                    { code: "000000" },
                    accountLifecycleMetadata("unavailable-factor-blocked")
                )
            ).toMatchObject({ status: "rate-limited" });
            expect(harness.totpDecryptionCalls()).toBe(decryptionCallsAtBlock);
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("account-mfa", accountLifecycleUserId)
                )
            ).toMatchObject({ failureCount: 3, kind: "account-mfa" });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.mfa.step-up'
                          AND outcome = 'denied'
                    `)
                    .get()
            ).toEqual({ count: 3 });
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });
});
