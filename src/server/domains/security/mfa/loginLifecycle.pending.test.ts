import { describe, expect, test } from "bun:test";

import { addMinutes } from "date-fns";

import {
    beginPasswordMfaLogin,
    createMfaLoginHarness,
    mfaLoginMetadata,
    mfaLoginNow,
    mfaLoginSessionCount,
} from "./testSupport/loginLifecycle.ts";

describe("MFA pending-login lifecycle", () => {
    test("issues only a validator-backed handoff and revokes it atomically", async () => {
        const harness = await createMfaLoginHarness();
        try {
            expect(
                await harness.authenticationService.login(
                    { password: "wrong-password-1", username: "operator" },
                    mfaLoginMetadata("request-wrong-password")
                )
            ).toEqual({ status: "invalid-credentials" });
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(
                        "SELECT count(*) AS count FROM auth_pending_logins"
                    )
                    .get()
            ).toEqual({ count: 0 });

            const pending = await beginPasswordMfaLogin(
                harness,
                "request-correct-password"
            );
            const stored = harness.database.sqlite
                .query<{ passwordVerifiedAt: number; validatorHash: string }, [string]>(`
                    SELECT
                        password_verified_at AS "passwordVerifiedAt",
                        validator_hash AS "validatorHash"
                    FROM auth_pending_logins
                    WHERE id = ?
                `)
                .get(pending.credential.prefix);

            expect(pending.pendingLogin).toEqual({
                expiresAtMs: addMinutes(mfaLoginNow, 5).getTime(),
                methods: ["recovery", "totp"],
                username: "operator",
            });
            expect(harness.service.pendingLoginSummary(pending.credential)).toEqual(
                pending.pendingLogin
            );
            expect(stored?.passwordVerifiedAt).toBe(mfaLoginNow.getTime());
            expect(stored?.validatorHash).toBe(pending.credential.validatorHash);
            expect(stored?.validatorHash).not.toContain(pending.token);
            expect(mfaLoginSessionCount(harness)).toBe(0);
            expect(harness.passwordVerificationCalls()).toBe(2);
            expect(harness.passwordCryptoTransactionStates).toEqual([false, false]);

            expect(
                harness.service.revokePendingLogin(
                    pending.credential,
                    mfaLoginMetadata("request-revoke")
                )
            ).toBeTrue();
            expect(
                harness.service.pendingLoginSummary(pending.credential)
            ).toBeUndefined();
            expect(
                harness.service.revokePendingLogin(
                    pending.credential,
                    mfaLoginMetadata("request-revoke-replay")
                )
            ).toBeFalse();
            expect(
                harness.database.sqlite
                    .query<{ count: number }, []>(`
                        SELECT count(*) AS count
                        FROM audit_events
                        WHERE action = 'auth.pending-login.revoke'
                          AND outcome = 'succeeded'
                    `)
                    .get()
            ).toEqual({ count: 1 });
        } finally {
            harness.close();
        }
    });
});
