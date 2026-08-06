import { describe, expect, test } from "bun:test";

import { rateLimitBucketKey } from "../authenticationRateLimit.ts";
import { pendingLoginAttemptMaximum } from "./lifecycleRepository.ts";
import {
    beginPasswordMfaLogin,
    createMfaLoginBarrier,
    createMfaLoginHarness,
    mfaLoginClientSourceId,
    mfaLoginMetadata,
    mfaLoginNow,
    mfaLoginSessionCount,
    mfaLoginTotpCodeAt,
    mfaLoginTotpFactorId,
    mfaLoginUserId,
} from "./testSupport/loginLifecycle.ts";

async function invalidTotpCode(): Promise<string> {
    return (await mfaLoginTotpCodeAt(mfaLoginNow)) === "000000" ? "111111" : "000000";
}

describe("MFA TOTP login lifecycle", () => {
    test("atomically consumes a pending login and TOTP step once", async () => {
        const harness = await createMfaLoginHarness();
        try {
            const pending = await beginPasswordMfaLogin(harness, "request-totp-pending");
            const code = await mfaLoginTotpCodeAt(mfaLoginNow);
            const completed = await harness.service.completeTotpLogin(
                pending.credential,
                { code },
                mfaLoginMetadata("request-totp-complete")
            );
            if (completed.status !== "authenticated") {
                throw new Error(`Expected TOTP completion, received ${completed.status}`);
            }
            const acceptedStep = Math.floor(mfaLoginNow.getTime() / 30_000);

            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(
                harness.repository.findTotpFactor(mfaLoginUserId, mfaLoginTotpFactorId)
                    ?.lastUsedStep
            ).toBe(acceptedStep);
            expect(
                harness.repository.findSession(mfaLoginUserId, completed.session.id)
            ).toMatchObject({
                authMethod: "totp",
                mfaVerifiedAt: mfaLoginNow,
                passwordVerifiedAt: mfaLoginNow,
            });
            expect(mfaLoginSessionCount(harness)).toBe(1);

            expect(
                await harness.service.completeTotpLogin(
                    pending.credential,
                    { code },
                    mfaLoginMetadata("request-totp-pending-replay")
                )
            ).toEqual({ status: "invalid-proof" });
            const replacement = await beginPasswordMfaLogin(
                harness,
                "request-totp-proof-replay-pending"
            );
            expect(
                await harness.service.completeTotpLogin(
                    replacement.credential,
                    { code },
                    mfaLoginMetadata("request-totp-proof-replay")
                )
            ).toEqual({ status: "invalid-proof" });
            expect(
                harness.repository.findPendingLogin(replacement.credential.prefix)
                    ?.attemptCount
            ).toBe(1);
            expect(mfaLoginSessionCount(harness)).toBe(1);
            expect(harness.totpCryptoTransactionStates).toEqual([false, false]);
        } finally {
            harness.close();
        }
    });

    test("rolls pending consumption back when the TOTP compare-and-swap loses", async () => {
        const harness = await createMfaLoginHarness();
        try {
            const pending = await beginPasswordMfaLogin(harness, "request-cas-pending");
            const code = await mfaLoginTotpCodeAt(mfaLoginNow);
            let raceInjected = false;
            harness.setBeforeTotpDecrypt(() => {
                if (raceInjected) return;
                raceInjected = true;
                harness.database.sqlite.run(
                    "UPDATE user_totp_factors SET last_used_step = 1 WHERE id = ?",
                    [mfaLoginTotpFactorId]
                );
            });

            expect(
                await harness.service.completeTotpLogin(
                    pending.credential,
                    { code },
                    mfaLoginMetadata("request-cas-race")
                )
            ).toEqual({ status: "state-changed" });
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toMatchObject({ attemptCount: 0 });
            expect(
                harness.repository.findTotpFactor(mfaLoginUserId, mfaLoginTotpFactorId)
                    ?.lastUsedStep
            ).toBe(1);
            expect(mfaLoginSessionCount(harness)).toBe(0);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.login.mfa' AND outcome = 'succeeded'
                    `)
                    .get()
            ).toEqual({ count: 0 });

            harness.setBeforeTotpDecrypt(undefined);
            expect(
                await harness.service.completeTotpLogin(
                    pending.credential,
                    { code },
                    mfaLoginMetadata("request-cas-retry")
                )
            ).toMatchObject({ status: "authenticated" });
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(mfaLoginSessionCount(harness)).toBe(1);
            expect(harness.totpCryptoTransactionStates).toEqual([false, false]);
        } finally {
            harness.close();
        }
    });

    test("serializes concurrent failures at the source threshold without extra writes", async () => {
        const harness = await createMfaLoginHarness();
        try {
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-concurrent-pending"
            );
            const code = await invalidTotpCode();
            const participants = 6;
            const barrier = createMfaLoginBarrier(2);
            harness.setBeforeTotpDecrypt(() => barrier.wait());

            const results = await Promise.all(
                Array.from({ length: participants }, (_, index) =>
                    harness.service.completeTotpLogin(
                        pending.credential,
                        { code },
                        mfaLoginMetadata(`request-concurrent-${index}`)
                    )
                )
            );

            expect(barrier.arrivals()).toBeLessThan(participants);
            expect(
                results.filter(({ status }) => status === "invalid-proof")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("login-mfa-source", mfaLoginClientSourceId)
                )
            ).toMatchObject({ failureCount: 3, kind: "login-mfa-source" });
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("login-mfa-global", "all-sources")
                )
            ).toMatchObject({ failureCount: 3, kind: "login-mfa-global" });
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
                    ?.attemptCount
            ).toBe(3);
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.login.mfa' AND outcome = 'denied'
                    `)
                    .get()
            ).toEqual({ count: 3 });

            expect(
                await harness.service.completeTotpLogin(
                    pending.credential,
                    { code },
                    mfaLoginMetadata("request-after-source-block")
                )
            ).toMatchObject({ status: "rate-limited" });
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
                    ?.attemptCount
            ).toBe(3);
            expect(harness.totpCryptoTransactionStates.length).toBeLessThan(participants);
            expect(
                harness.totpCryptoTransactionStates.every((state) => !state)
            ).toBeTrue();
        } finally {
            harness.close();
        }
    });

    test("rejects exhausted process TOTP budget before decrypting", async () => {
        const harness = await createMfaLoginHarness({
            totpWorkBudget: Object.freeze({
                consume: () => ({ accepted: false as const, retryAfterSeconds: 7 }),
            }),
        });
        try {
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-budget-pending"
            );

            expect(
                await harness.service.completeTotpLogin(
                    pending.credential,
                    { code: await mfaLoginTotpCodeAt(mfaLoginNow) },
                    mfaLoginMetadata("request-budget-exhausted")
                )
            ).toEqual({ retryAfterSeconds: 7, status: "rate-limited" });
            expect(harness.totpCryptoTransactionStates).toEqual([]);
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
                    ?.attemptCount
            ).toBe(0);
        } finally {
            harness.close();
        }
    });

    test("accounts for wrong proofs when another TOTP factor is unavailable", async () => {
        const harness = await createMfaLoginHarness();
        try {
            harness.insertUnavailableTotpFactor();
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-unavailable-factor-pending"
            );
            const code = await invalidTotpCode();

            const results = [];
            for (let index = 0; index < 3; index += 1) {
                results.push(
                    await harness.service.completeTotpLogin(
                        pending.credential,
                        { code },
                        mfaLoginMetadata(`request-unavailable-factor-${index}`)
                    )
                );
            }

            expect(results.map(({ status }) => status)).toEqual([
                "service-unavailable",
                "service-unavailable",
                "rate-limited",
            ]);
            expect(harness.totpCryptoTransactionStates).toEqual(
                Array.from({ length: 6 }, () => false)
            );
            const cryptoCallsAtBlock = harness.totpCryptoTransactionStates.length;
            expect(
                await harness.service.completeTotpLogin(
                    pending.credential,
                    { code },
                    mfaLoginMetadata("request-unavailable-factor-blocked")
                )
            ).toMatchObject({ status: "rate-limited" });
            expect(harness.totpCryptoTransactionStates).toHaveLength(cryptoCallsAtBlock);
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
                    ?.attemptCount
            ).toBe(3);
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("login-mfa-source", mfaLoginClientSourceId)
                )
            ).toMatchObject({ failureCount: 3, kind: "login-mfa-source" });
            expect(
                harness.repository.findRateLimitBucket(
                    rateLimitBucketKey("login-mfa-global", "all-sources")
                )
            ).toMatchObject({ failureCount: 3, kind: "login-mfa-global" });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.login.mfa' AND outcome = 'denied'
                    `)
                    .get()
            ).toEqual({ count: 3 });
        } finally {
            harness.close();
        }
    });

    test("deletes a pending login at its proof-attempt maximum", async () => {
        const harness = await createMfaLoginHarness();
        try {
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-exhaustion-pending"
            );
            const code = await invalidTotpCode();

            for (let index = 0; index < pendingLoginAttemptMaximum; index += 1) {
                expect(
                    await harness.service.completeTotpLogin(
                        pending.credential,
                        { code },
                        mfaLoginMetadata(
                            `request-exhaustion-${index}`,
                            `mfa-exhaustion-source-${index}`
                        )
                    )
                ).toEqual({ status: "invalid-proof" });
            }
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(
                harness.service.pendingLoginSummary(pending.credential)
            ).toBeUndefined();
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.login.mfa' AND outcome = 'denied'
                    `)
                    .get()
            ).toEqual({ count: pendingLoginAttemptMaximum });
            expect(harness.totpCryptoTransactionStates).toEqual(
                Array.from({ length: pendingLoginAttemptMaximum }, () => false)
            );
        } finally {
            harness.close();
        }
    });
});
