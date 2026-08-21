import { describe, expect, test } from "bun:test";

import { createTestAuthenticationWorkGate } from "../../../test/support/authenticationWorkGate.ts";
import {
    beginPasswordMfaLogin,
    createMfaLoginHarness,
    mfaLoginMetadata,
    mfaLoginNow,
    mfaLoginRecoveryCode,
    mfaLoginRecoveryCodeSelector,
    mfaLoginSessionCount,
    mfaLoginUserId,
} from "./testSupport/loginLifecycle.ts";

describe("MFA recovery login lifecycle", () => {
    test("atomically consumes a pending login and recovery code once", async () => {
        const harness = await createMfaLoginHarness();
        try {
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-recovery-pending"
            );
            const completed = await harness.service.completeRecoveryLogin(
                pending.credential,
                { code: mfaLoginRecoveryCode },
                mfaLoginMetadata("request-recovery-complete")
            );
            if (completed.status !== "authenticated") {
                throw new Error(
                    `Expected recovery completion, received ${completed.status}`
                );
            }

            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
            ).toBeUndefined();
            expect(
                harness.repository.findRecoveryCode(
                    mfaLoginUserId,
                    mfaLoginRecoveryCodeSelector
                )?.usedAt
            ).toEqual(mfaLoginNow);
            expect(
                harness.repository.findSession(mfaLoginUserId, completed.session.id)
            ).toMatchObject({
                authMethod: "recovery",
                mfaVerifiedAt: mfaLoginNow,
                passwordVerifiedAt: mfaLoginNow,
            });
            expect(mfaLoginSessionCount(harness)).toBe(1);

            expect(
                await harness.service.completeRecoveryLogin(
                    pending.credential,
                    { code: mfaLoginRecoveryCode },
                    mfaLoginMetadata("request-recovery-pending-replay")
                )
            ).toEqual({ status: "invalid-proof" });
            const replacement = await beginPasswordMfaLogin(
                harness,
                "request-recovery-proof-replay-pending"
            );
            expect(replacement.pendingLogin.methods).toEqual(["totp"]);
            expect(
                await harness.service.completeRecoveryLogin(
                    replacement.credential,
                    { code: mfaLoginRecoveryCode },
                    mfaLoginMetadata("request-recovery-proof-replay")
                )
            ).toEqual({ status: "invalid-proof" });
            expect(
                harness.repository.findPendingLogin(replacement.credential.prefix)
                    ?.attemptCount
            ).toBe(0);
            expect(mfaLoginSessionCount(harness)).toBe(1);
            expect(harness.recoveryCryptoTransactionStates).toEqual([false]);
        } finally {
            harness.close();
        }
    });

    test("commits recovery cooldown before admitting queued verification", async () => {
        const harness = await createMfaLoginHarness({
            passwordWorkGate: createTestAuthenticationWorkGate(1, 16),
        });
        try {
            const pending = await beginPasswordMfaLogin(
                harness,
                "request-queued-recovery-pending"
            );
            const invalidCode = `${mfaLoginRecoveryCodeSelector}-${"f".repeat(32)}`;
            const participants = 6;

            const results = await Promise.all(
                Array.from({ length: participants }, (_, index) =>
                    harness.service.completeRecoveryLogin(
                        pending.credential,
                        { code: invalidCode },
                        mfaLoginMetadata(`request-queued-recovery-${index}`)
                    )
                )
            );

            expect(harness.recoveryCryptoTransactionStates).toHaveLength(3);
            expect(
                results.filter(({ status }) => status === "invalid-proof")
            ).toHaveLength(2);
            expect(
                results.filter(({ status }) => status === "rate-limited")
            ).toHaveLength(4);
            expect(
                harness.repository.findPendingLogin(pending.credential.prefix)
                    ?.attemptCount
            ).toBe(3);
        } finally {
            harness.close();
        }
    });
});
