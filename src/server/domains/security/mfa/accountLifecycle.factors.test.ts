import { describe, expect, test } from "bun:test";

import {
    recoveryCodeCount,
    totpFactorMaximumPerUser,
} from "../../../../contracts/accountSecurity.ts";
import { rateLimitBucketKey } from "../authenticationRateLimit.ts";
import {
    accountLifecycleInitialSessionId,
    accountLifecycleMetadata,
    accountLifecycleOtherSessionId,
    accountLifecycleUserId,
    createAccountLifecycleBarrier,
    createAccountLifecycleHarness,
    enableAccountMfa,
} from "./testSupport/accountLifecycle.ts";

describe("MFA account factor lifecycle", () => {
    test("enables MFA atomically after replacing pending enrollment", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const identity = {
                sessionId: accountLifecycleInitialSessionId,
                userId: accountLifecycleUserId,
            };
            const discarded = await harness.service.beginTotpEnrollment(
                identity,
                { label: "Discarded authenticator" },
                accountLifecycleMetadata("begin-discarded")
            );
            const enrollment = await harness.service.beginTotpEnrollment(
                identity,
                { label: "Primary authenticator" },
                accountLifecycleMetadata("begin-primary")
            );
            if (discarded.status !== "created" || enrollment.status !== "created") {
                throw new Error("Expected TOTP enrollment creation");
            }
            expect(
                await harness.service.confirmTotpEnrollment(
                    identity,
                    { code: "123456", factorId: discarded.enrollment.factorId },
                    accountLifecycleMetadata("confirm-discarded")
                )
            ).toEqual({ status: "state-changed" });

            const confirmed = await harness.service.confirmTotpEnrollment(
                identity,
                { code: "123456", factorId: enrollment.enrollment.factorId },
                accountLifecycleMetadata("confirm-primary")
            );
            if (confirmed.status !== "confirmed" || !confirmed.enabledNow) {
                throw new Error(
                    `Expected first-factor confirmation, received ${confirmed.status}`
                );
            }
            const currentIdentity = {
                sessionId: confirmed.session.id,
                userId: accountLifecycleUserId,
            };
            const user = harness.repository.findUserById(accountLifecycleUserId);

            expect(confirmed.recoveryCodes).toHaveLength(recoveryCodeCount);
            expect(confirmed.revokedSessions).toBe(1);
            expect(user?.authenticationVersion).toBe(2);
            expect(user?.mfaEnabledAt).not.toBeNull();
            expect(
                harness.repository.findSession(
                    accountLifecycleUserId,
                    accountLifecycleInitialSessionId
                )
            ).toBeUndefined();
            expect(
                harness.repository.findSession(
                    accountLifecycleUserId,
                    accountLifecycleOtherSessionId
                )
            ).toBeUndefined();
            expect(
                harness.repository.findSession(
                    accountLifecycleUserId,
                    currentIdentity.sessionId
                )
            ).toMatchObject({ authenticationVersion: 2, authMethod: "totp" });
            expect(
                harness.repository.countConfirmedTotpFactors(accountLifecycleUserId)
            ).toBe(1);
            expect(
                harness.repository.countUnusedRecoveryCodes(accountLifecycleUserId)
            ).toBe(recoveryCodeCount);
            expect(harness.service.summary(currentIdentity)).toMatchObject({
                status: "found",
                summary: {
                    mfa: {
                        enabled: true,
                        recoveryCodesRemaining: recoveryCodeCount,
                        totpFactors: [{ id: enrollment.enrollment.factorId }],
                    },
                    recentAuth: { mfa: { recent: true }, password: { recent: true } },
                },
            });
            expect(harness.maximumConcurrentRecoveryHashes()).toBe(1);
            expect(harness.consumedWorkUnits).toEqual([recoveryCodeCount]);
            expect(harness.consumedTotpWorkUnits).toEqual([1]);
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });

    test("enforces factor limits and protects the final confirmed factor", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const enabled = await enableAccountMfa(harness);
            const factorIds = [enabled.factorId];

            for (let index = 1; index < totpFactorMaximumPerUser; index += 1) {
                const begun = await harness.service.beginTotpEnrollment(
                    enabled.identity,
                    { label: `Authenticator ${index + 1}` },
                    accountLifecycleMetadata(`begin-${index + 1}`)
                );
                if (begun.status !== "created") {
                    throw new Error(`Expected factor ${index + 1} enrollment`);
                }
                const confirmed = await harness.service.confirmTotpEnrollment(
                    enabled.identity,
                    { code: "123456", factorId: begun.enrollment.factorId },
                    accountLifecycleMetadata(`confirm-${index + 1}`)
                );
                expect(confirmed).toMatchObject({
                    enabledNow: false,
                    status: "confirmed",
                });
                factorIds.push(begun.enrollment.factorId);
            }

            expect(
                await harness.service.beginTotpEnrollment(
                    enabled.identity,
                    { label: "Authenticator 5" },
                    accountLifecycleMetadata("begin-over-limit")
                )
            ).toEqual({ status: "factor-limit" });
            for (const factorId of factorIds.slice(0, -1)) {
                expect(
                    harness.service.removeTotpFactor(
                        enabled.identity,
                        { factorId },
                        accountLifecycleMetadata(`remove-${factorId}`)
                    )
                ).toMatchObject({ factorId, removed: true, status: "removed" });
            }
            expect(
                harness.service.removeTotpFactor(
                    enabled.identity,
                    { factorId: factorIds.at(-1)! },
                    accountLifecycleMetadata("remove-final")
                )
            ).toEqual({ status: "final-factor" });
            expect(
                harness.repository.countConfirmedTotpFactors(accountLifecycleUserId)
            ).toBe(1);
            expect(harness.cryptoTransactionStates).not.toContain(true);
        } finally {
            harness.close();
        }
    });

    test("serializes concurrent confirmation failures at the source threshold", async () => {
        const harness = await createAccountLifecycleHarness();
        try {
            const identity = {
                sessionId: accountLifecycleInitialSessionId,
                userId: accountLifecycleUserId,
            };
            const enrollment = await harness.service.beginTotpEnrollment(
                identity,
                { label: "Concurrent authenticator" },
                accountLifecycleMetadata("begin-concurrent")
            );
            if (enrollment.status !== "created") {
                throw new Error(`Expected enrollment, received ${enrollment.status}`);
            }
            const participants = 6;
            const barrier = createAccountLifecycleBarrier(participants);
            harness.setBeforeTotpVerification((token) =>
                token === "000000" ? barrier.wait() : Promise.resolve()
            );

            const results = await Promise.all(
                Array.from({ length: participants }, (_, index) =>
                    harness.service.confirmTotpEnrollment(
                        identity,
                        { code: "000000", factorId: enrollment.enrollment.factorId },
                        accountLifecycleMetadata(`concurrent-confirm-${index}`)
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
                        WHERE action = 'auth.mfa.totp.enrollment.confirm'
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
