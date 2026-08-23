import { describe, expect, test } from "bun:test";

import {
    authenticationLifecycleMetadata,
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
} from "./testSupport/authenticationLifecycle.ts";

describe("authentication password recovery", () => {
    test("stops projecting an expired pending email change", async () => {
        const harness = await createAuthenticationLifecycleHarness({
            passwordRecoveryEmailSender: {
                send: () => Promise.resolve(),
                sendVerification: () => Promise.resolve(),
            },
            publicOrigin: "https://dashboard.example.com",
        });
        try {
            const bootstrap = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: bootstrap.session.id,
                userId: bootstrap.user.id,
            };
            await harness.service.changeEmail(
                identity,
                { email: "replacement@example.com" },
                authenticationLifecycleMetadata
            );
            expect(harness.service.status(identity)).toMatchObject({
                user: { pendingEmail: "replacement@example.com" },
            });
            harness.advanceSeconds(15 * 60 + 1);
            const expiredStatus = harness.service.status(identity);
            expect(expiredStatus).toMatchObject({
                user: { email: "operator@example.com" },
            });
            expect(expiredStatus.authenticated).toBeTrue();
            if (!expiredStatus.authenticated) throw new Error("Session expired early");
            expect("pendingEmail" in expiredStatus.user).toBeFalse();
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("keeps the old address active until a changed email is verified", async () => {
        const verificationUrls: string[] = [];
        const harness = await createAuthenticationLifecycleHarness({
            passwordRecoveryEmailSender: {
                send: () => Promise.resolve(),
                sendVerification(message) {
                    verificationUrls.push(message.verificationUrl);
                    return Promise.resolve();
                },
            },
            publicOrigin: "https://dashboard.example.com",
        });
        try {
            const bootstrap = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: bootstrap.session.id,
                userId: bootstrap.user.id,
            };
            expect(
                await harness.service.changeEmail(
                    identity,
                    { email: "replacement@example.com" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ email: "replacement@example.com", status: "changed" });
            expect(harness.service.status(identity)).toMatchObject({
                user: { email: "operator@example.com" },
            });
            const token = new URL(verificationUrls.at(-1) ?? "").searchParams.get(
                "verifyEmailToken"
            );
            if (token === null) throw new Error("Verification URL omitted its token");
            expect(
                await harness.service.verifyEmail(
                    { token },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ email: "replacement@example.com", status: "verified" });
            expect(harness.service.status(identity)).toMatchObject({
                user: { email: "replacement@example.com" },
            });
            expect(
                await harness.service.changeEmail(
                    identity,
                    { email: "replacement@example.com" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "already-verified" });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("keeps the delivered email-verification token when replacement delivery fails", async () => {
        const verificationUrls: string[] = [];
        let changeDeliveryCount = 0;
        const harness = await createAuthenticationLifecycleHarness({
            passwordRecoveryEmailSender: {
                send: () => Promise.resolve(),
                sendVerification(message) {
                    verificationUrls.push(message.verificationUrl);
                    changeDeliveryCount += 1;
                    return changeDeliveryCount === 3
                        ? Promise.reject(new Error("simulated delivery failure"))
                        : Promise.resolve();
                },
            },
            publicOrigin: "https://dashboard.example.com",
        });
        try {
            const bootstrap = await bootstrapAuthenticationLifecycle(harness);
            const identity = {
                sessionId: bootstrap.session.id,
                userId: bootstrap.user.id,
            };
            expect(
                await harness.service.changeEmail(
                    identity,
                    { email: "first-replacement@example.com" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ email: "first-replacement@example.com", status: "changed" });
            expect(
                await harness.service.changeEmail(
                    identity,
                    { email: "second-replacement@example.com" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "service-unavailable" });

            const deliveredToken = new URL(verificationUrls[1] ?? "").searchParams.get(
                "verifyEmailToken"
            );
            if (deliveredToken === null)
                throw new Error("Verification URL omitted its token");
            expect(
                await harness.service.verifyEmail(
                    { token: deliveredToken },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ email: "first-replacement@example.com", status: "verified" });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("keeps account discovery generic and consumes one emailed token", async () => {
        const messages: { readonly resetUrl: string; readonly to: string }[] = [];
        const verificationUrls: string[] = [];
        const harness = await createAuthenticationLifecycleHarness({
            passwordRecoveryEmailSender: {
                send(message) {
                    messages.push({ resetUrl: message.resetUrl, to: message.to });
                    return Promise.resolve();
                },
                sendVerification(message) {
                    verificationUrls.push(message.verificationUrl);
                    return Promise.resolve();
                },
            },
            publicOrigin: "https://dashboard.example.com",
        });
        try {
            const bootstrap = await bootstrapAuthenticationLifecycle(harness);
            const verificationToken = new URL(verificationUrls[0] ?? "").searchParams.get(
                "verifyEmailToken"
            );
            if (verificationToken === null)
                throw new Error("Verification URL omitted its token");
            expect(
                await harness.service.verifyEmail(
                    { token: verificationToken },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ email: "operator@example.com", status: "verified" });
            expect(
                await harness.service.requestPasswordReset(
                    { username: "missing" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "accepted" });
            expect(messages).toHaveLength(0);

            expect(
                await harness.service.requestPasswordReset(
                    { username: "operator" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "accepted" });
            expect(messages).toHaveLength(1);
            expect(messages[0]?.to).toBe("operator@example.com");
            const token = new URL(messages[0]?.resetUrl ?? "").searchParams.get(
                "resetToken"
            );
            if (token === null) throw new Error("Reset URL omitted its token");

            expect(
                await harness.service.resetPassword(
                    { password: "replacement-password-2", token },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "reset" });
            expect(
                harness.service.status({
                    sessionId: bootstrap.session.id,
                    userId: bootstrap.user.id,
                }).authenticated
            ).toBeFalse();
            expect(
                await harness.service.resetPassword(
                    { password: "replacement-password-3", token },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "invalid-token" });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("fails closed for every username when delivery is not configured", async () => {
        const harness = await createAuthenticationLifecycleHarness();
        try {
            await bootstrapAuthenticationLifecycle(harness);
            expect(
                await harness.service.requestPasswordReset(
                    { username: "operator" },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "service-unavailable" });
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
