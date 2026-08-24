import { describe, expect, test } from "bun:test";

import {
    authenticationLifecycleMetadata,
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
} from "./testSupport/authenticationLifecycle.ts";

describe("authentication password recovery", () => {
    test("stops projecting a pending email invalidated by a password change", async () => {
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

            const changed = await harness.service.changePassword(
                identity,
                {
                    currentPassword: "current-password-1",
                    newPassword: "replacement-password-2",
                },
                authenticationLifecycleMetadata
            );
            expect(changed.status).toBe("changed");
            if (changed.status !== "changed") throw new Error("Password change failed");
            const changedIdentity = {
                sessionId: changed.session.id,
                userId: changed.user.id,
            };
            const status = harness.service.status(changedIdentity);
            expect(status.authenticated).toBeTrue();
            if (!status.authenticated) throw new Error("Changed session is invalid");
            expect(status.user.email).toBe("operator@example.com");
            expect("pendingEmail" in status.user).toBeFalse();
        } finally {
            harness.database.sqlite.close(true);
        }
    });

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

    test("serializes overlapping email changes and invalidates superseded links", async () => {
        const verificationUrls: string[] = [];
        const deliveries: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
        const harness = await createAuthenticationLifecycleHarness({
            passwordRecoveryEmailSender: {
                send: () => Promise.resolve(),
                sendVerification(message) {
                    verificationUrls.push(message.verificationUrl);
                    if (verificationUrls.length === 1) return Promise.resolve();
                    const delivery = Promise.withResolvers<void>();
                    deliveries.push(delivery);
                    return delivery.promise;
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
            const first = harness.service.changeEmail(
                identity,
                { email: "first-overlap@example.com" },
                authenticationLifecycleMetadata
            );
            await Bun.sleep(0);
            const second = harness.service.changeEmail(
                identity,
                { email: "second-overlap@example.com" },
                authenticationLifecycleMetadata
            );
            await Bun.sleep(0);
            expect(verificationUrls).toHaveLength(2);

            deliveries[0]?.resolve();
            expect(await first).toEqual({
                email: "first-overlap@example.com",
                status: "changed",
            });
            await Bun.sleep(0);
            expect(verificationUrls).toHaveLength(3);
            deliveries[1]?.resolve();
            expect(await second).toEqual({
                email: "second-overlap@example.com",
                status: "changed",
            });

            const firstToken = new URL(verificationUrls[1] ?? "").searchParams.get(
                "verifyEmailToken"
            );
            const secondToken = new URL(verificationUrls[2] ?? "").searchParams.get(
                "verifyEmailToken"
            );
            if (firstToken === null || secondToken === null) {
                throw new Error("Verification URL omitted its token");
            }
            expect(
                await harness.service.verifyEmail(
                    { token: firstToken },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "invalid-token" });
            expect(
                await harness.service.verifyEmail(
                    { token: secondToken },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ email: "second-overlap@example.com", status: "verified" });
        } finally {
            for (const delivery of deliveries) delivery.resolve();
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
            await Bun.sleep(0);
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

    test("serializes overlapping reset deliveries and retains only the newest token", async () => {
        const messages: { readonly resetUrl: string }[] = [];
        const deliveries: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
        const verificationUrls: string[] = [];
        const harness = await createAuthenticationLifecycleHarness({
            passwordRecoveryEmailSender: {
                send(message) {
                    messages.push(message);
                    const delivery = Promise.withResolvers<void>();
                    deliveries.push(delivery);
                    return delivery.promise;
                },
                sendVerification(message) {
                    verificationUrls.push(message.verificationUrl);
                    return Promise.resolve();
                },
            },
            publicOrigin: "https://dashboard.example.com",
        });
        try {
            const waitForMessageCount = async (count: number) => {
                for (let attempt = 0; attempt < 100; attempt += 1) {
                    if (messages.length === count) return;
                    await Bun.sleep(1);
                }
                expect(messages).toHaveLength(count);
            };
            await bootstrapAuthenticationLifecycle(harness);
            const verificationToken = new URL(
                verificationUrls.at(-1) ?? ""
            ).searchParams.get("verifyEmailToken");
            if (verificationToken === null) {
                throw new Error("Verification URL omitted its token");
            }
            expect(
                await harness.service.verifyEmail(
                    { token: verificationToken },
                    authenticationLifecycleMetadata
                )
            ).toMatchObject({ status: "verified" });
            const requests = ["source-a", "source-b", "source-c"].map((clientSourceId) =>
                harness.service.requestPasswordReset(
                    { username: "operator" },
                    { ...authenticationLifecycleMetadata, clientSourceId }
                )
            );
            await waitForMessageCount(1);
            expect(messages).toHaveLength(1);
            deliveries[0]?.resolve();
            await waitForMessageCount(2);
            expect(messages).toHaveLength(2);
            deliveries[1]?.resolve();
            await waitForMessageCount(3);
            expect(messages).toHaveLength(3);
            deliveries[2]?.resolve();
            expect(await Promise.all(requests)).toEqual([
                { status: "accepted" },
                { status: "accepted" },
                { status: "accepted" },
            ]);

            const tokens = messages.map(({ resetUrl }) =>
                new URL(resetUrl).searchParams.get("resetToken")
            );
            if (tokens.some((token) => token === null)) {
                throw new Error("Reset URL omitted its token");
            }
            expect(
                await harness.service.resetPassword(
                    { password: "replacement-password-2", token: tokens[0]! },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "invalid-token" });
            expect(
                await harness.service.resetPassword(
                    { password: "replacement-password-2", token: tokens[1]! },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "invalid-token" });
            expect(
                await harness.service.resetPassword(
                    { password: "replacement-password-2", token: tokens[2]! },
                    authenticationLifecycleMetadata
                )
            ).toEqual({ status: "reset" });
        } finally {
            for (const delivery of deliveries) delivery.resolve();
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
