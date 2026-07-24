import type { Server } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import { generate } from "otplib";

import {
    changePasswordAndRotateSession,
    createSession,
    createUser,
    findUserById,
    getAuthSessionFromSessionId,
    verifyPassword,
} from "../src/auth.ts";
import { database } from "../src/database.ts";
import {
    requiresRecentMfa,
    resetRequestPolicyForTests,
    withRequestPolicy,
} from "../src/requestPolicy.ts";
import { accountSecurityRoutes } from "../src/routes/accountSecurityRoutes.ts";
import {
    authenticationThrottleStatus,
    clearAuthenticationFailures,
    recordAuthenticationFailure,
} from "../src/services/authenticationThrottle.ts";
import {
    CONFIG_REDACTION_SENTINEL,
    hasConfigRedactionSentinel,
    redactConfigJsonText,
    redactConfigSecrets,
    restoreConfigRedactionSentinels,
} from "../src/services/configRedaction.ts";
import { decryptStoredSecret, encryptStoredSecret } from "../src/services/mfaCrypto.ts";
import {
    confirmTotpEnrollment,
    consumePendingLogin,
    createPendingLogin,
    createTotpEnrollment,
    getPendingLogin,
    validateTotpStorageConfig,
    verifyRecoveryCodeForUser,
    verifyTotpForUser,
} from "../src/services/multiFactorAuth.ts";
import { didRemoveWebAuthnCredential, webAuthnConfig } from "../src/services/webAuthn.ts";

const USER_PREFIX = "mfa-test-";
const originalSecretEncryptionKey = process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;

function encryptionKey(fill: number): string {
    return new Uint8Array(32).fill(fill).toBase64();
}

function configureMfaEncryption(): void {
    process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = encryptionKey(7);
}

function sessionCookieHeader(response: Response): string {
    const match = response.headers
        .get("set-cookie")
        ?.match(/mira_dashboard_session=([^;,]+)/u);
    if (!match?.[1]) {
        throw new Error("Response did not set a Dashboard session cookie");
    }
    return `mira_dashboard_session=${match[1]}`;
}

function accountSecurityRequest(
    route: string,
    sessionCookie: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST"
): Request {
    return new Request(`https://dashboard.example${route}`, {
        ...(body !== undefined && { body: JSON.stringify(body) }),
        headers: {
            cookie: sessionCookie,
            ...(body !== undefined && {
                "Content-Type": "application/json",
            }),
        },
        method,
    });
}

afterEach(() => {
    resetRequestPolicyForTests();
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    database.prepare("DELETE FROM users WHERE username LIKE ?").run(`${USER_PREFIX}%`);
    if (originalSecretEncryptionKey === undefined) {
        delete process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;
    } else {
        process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = originalSecretEncryptionKey;
    }
});

describe("Dashboard multi-factor authentication", () => {
    it("binds encrypted secret envelopes to both key and storage context", () => {
        const envelope = encryptStoredSecret(
            "stored-secret",
            "mira-dashboard:test:context-a",
            encryptionKey(7)
        );

        expect(envelope).toStartWith("v1.");
        expect(envelope).not.toContain("stored-secret");
        expect(
            decryptStoredSecret(
                envelope,
                "mira-dashboard:test:context-a",
                encryptionKey(7)
            )
        ).toBe("stored-secret");
        expect(() =>
            decryptStoredSecret(
                envelope,
                "mira-dashboard:test:context-b",
                encryptionKey(7)
            )
        ).toThrow("Failed to decrypt stored secret");
        expect(() =>
            decryptStoredSecret(
                envelope,
                "mira-dashboard:test:context-a",
                encryptionKey(8)
            )
        ).toThrow("Failed to decrypt stored secret");
        expect(() =>
            decryptStoredSecret(
                "plaintext",
                "mira-dashboard:test:context-a",
                encryptionKey(7)
            )
        ).toThrow("Unsupported stored-secret envelope");
    });

    it("matches the RFC 6238 SHA-1 vector on Bun's recommended otplib plugins", async () => {
        expect(
            await generate({
                algorithm: "sha1",
                digits: 8,
                epoch: 59,
                period: 30,
                secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
                strategy: "totp",
            })
        ).toBe("94287082");
    });

    it("encrypts TOTP seeds, hashes recovery codes, and rejects replay", async () => {
        configureMfaEncryption();
        const user = await createUser(`${USER_PREFIX}totp`, "initial-password");
        const enrollment = await createTotpEnrollment(
            user.id,
            user.username,
            "Authenticator app"
        );
        const storedEnrollment = database
            .prepare(
                `SELECT encrypted_secret
                 FROM user_totp_factors
                 WHERE id = ?`
            )
            .get(enrollment.factorId) as { encrypted_secret: string };
        expect(storedEnrollment.encrypted_secret).toStartWith("v1.");
        expect(storedEnrollment.encrypted_secret).not.toContain(enrollment.secret);
        expect(validateTotpStorageConfig()).toBeUndefined();
        process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = encryptionKey(8);
        expect(() => validateTotpStorageConfig()).toThrow(
            "Failed to decrypt stored secret"
        );
        configureMfaEncryption();

        const token = await generate({
            algorithm: "sha1",
            digits: 6,
            period: 30,
            secret: enrollment.secret,
            strategy: "totp",
        });
        const confirmation = await confirmTotpEnrollment(
            user.id,
            enrollment.factorId,
            token
        );
        expect(confirmation?.enabledMfa).toBe(true);
        expect(confirmation?.recoveryCodes).toHaveLength(10);
        expect(findUserById(user.id)?.mfa_enabled_at).toBeTruthy();

        const recoveryRows = database
            .prepare(
                `SELECT id, validator_hash
                 FROM user_recovery_codes
                 WHERE user_id = ?`
            )
            .all(user.id) as Array<{
            id: string;
            validator_hash: string;
        }>;
        expect(recoveryRows).toHaveLength(10);
        const recoveryCodes = confirmation?.recoveryCodes ?? [];
        for (const code of recoveryCodes) {
            const [selector, validator] = code.split("-", 2);
            const row = recoveryRows.find((candidate) => candidate.id === selector);
            expect(row?.validator_hash).toStartWith("$");
            expect(row?.validator_hash).not.toContain(validator ?? "");
            expect(row?.validator_hash).not.toBe(code);
        }

        database
            .prepare(
                `UPDATE user_totp_factors
                 SET last_used_step = NULL
                 WHERE id = ?`
            )
            .run(enrollment.factorId);
        expect(await verifyTotpForUser(user.id, token)).toMatchObject({
            id: enrollment.factorId,
        });
        expect(await verifyTotpForUser(user.id, token)).toBeUndefined();

        const recoveryCode = confirmation?.recoveryCodes?.[0];
        expect(recoveryCode).toBeDefined();
        expect(await verifyRecoveryCodeForUser(user.id, recoveryCode!)).toBe(true);
        expect(await verifyRecoveryCodeForUser(user.id, recoveryCode!)).toBe(false);
    });

    it("stores only pending-login hashes and consumes the token once", async () => {
        const user = await createUser(`${USER_PREFIX}pending`, "initial-password");
        const pendingToken = createPendingLogin(user.id, ["totp"], "test browser");
        const [selector, validator] = pendingToken.split(".", 2);
        expect(selector).toBeDefined();
        const stored = database
            .prepare(
                `SELECT id, validator_hash
                 FROM auth_pending_logins
                 WHERE user_id = ?`
            )
            .get(user.id) as {
            id: string;
            validator_hash: string;
        };
        expect(stored.id).toBe(selector ?? "");
        expect(stored.validator_hash).toMatch(/^[a-f0-9]{64}$/u);
        expect(stored.validator_hash).not.toContain(validator ?? "");
        expect(getPendingLogin(pendingToken)).toMatchObject({
            userId: user.id,
        });
        expect(consumePendingLogin(pendingToken)).toMatchObject({
            userId: user.id,
        });
        expect(consumePendingLogin(pendingToken)).toBeUndefined();
    });

    it("rotates the current session and revokes other sessions on password change", async () => {
        const user = await createUser(`${USER_PREFIX}password`, "initial-password");
        const current = createSession(user.id, {
            userAgent: "current browser",
        });
        const other = createSession(user.id, {
            userAgent: "other browser",
        });

        const changed = await changePasswordAndRotateSession(
            current,
            user.id,
            "replacement-password"
        );
        expect(changed?.revokedSessions).toBe(1);
        expect(getAuthSessionFromSessionId(current)).toBeUndefined();
        expect(getAuthSessionFromSessionId(other)).toBeUndefined();
        expect(getAuthSessionFromSessionId(changed!.sessionToken)).toMatchObject({
            id: user.id,
        });
        const updatedUser = findUserById(user.id);
        expect(updatedUser).toBeDefined();
        expect(
            await verifyPassword("replacement-password", updatedUser!.password_hash)
        ).toBe(true);
        expect(await verifyPassword("initial-password", updatedUser!.password_hash)).toBe(
            false
        );
    });

    it("allows a backup YubiKey but never removes the final factor", async () => {
        const user = await createUser(`${USER_PREFIX}keys`, "initial-password");
        const timestamp = new Date().toISOString();
        database
            .prepare(
                `UPDATE users
                 SET mfa_enabled_at = ?, updated_at = ?
                 WHERE id = ?`
            )
            .run(timestamp, timestamp, user.id);
        const insert = database.prepare(
            `INSERT INTO user_webauthn_credentials (
                id, user_id, public_key, counter, transports_json,
                device_type, backed_up, label, created_at
             ) VALUES (?, ?, ?, 0, '["usb"]', 'singleDevice', 0, ?, ?)`
        );
        insert.run(
            "credential_primary",
            user.id,
            new Uint8Array([1, 2, 3]),
            "Primary YubiKey",
            timestamp
        );
        insert.run(
            "credential_backup",
            user.id,
            new Uint8Array([4, 5, 6]),
            "Backup YubiKey",
            timestamp
        );

        expect(didRemoveWebAuthnCredential(user.id, "credential_primary")).toBe(true);
        expect(didRemoveWebAuthnCredential(user.id, "credential_backup")).toBe(false);
    });

    it("requires an explicit stable HTTPS WebAuthn origin", () => {
        expect(
            webAuthnConfig({
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: "https://dashboard.example.com",
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            })
        ).toEqual({
            expectedOrigins: ["https://dashboard.example.com"],
            rpId: "dashboard.example.com",
            rpName: "Mira Dashboard",
        });
        const rawIpOrigin = new URL("https://192.0.2.10");
        rawIpOrigin.protocol = "http:";
        expect(() =>
            webAuthnConfig({
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: rawIpOrigin.origin,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "192.0.2.10",
            })
        ).toThrow("stable DNS hostname");
        const insecureOrigin = new URL("https://dashboard.example.com");
        insecureOrigin.protocol = "http:";
        expect(() =>
            webAuthnConfig({
                MIRA_DASHBOARD_WEBAUTHN_ORIGINS: insecureOrigin.origin,
                MIRA_DASHBOARD_WEBAUTHN_RP_ID: "dashboard.example.com",
            })
        ).toThrow("HTTPS origin");
    });

    it("persists account-scoped progressive authentication cooldowns", () => {
        const startedAt = new Date("2026-07-24T12:00:00.000Z");
        const subject = `${USER_PREFIX}throttle`;
        expect(
            authenticationThrottleStatus("login-password", subject, startedAt)
        ).toEqual({ allowed: true });
        expect(recordAuthenticationFailure("login-password", subject, startedAt)).toEqual(
            { allowed: true }
        );
        recordAuthenticationFailure(
            "login-password",
            subject,
            new Date(startedAt.getTime() + 1000)
        );
        const thirdFailureAt = new Date(startedAt.getTime() + 2000);
        const blockedCheckAt = new Date(startedAt.getTime() + 3000);
        expect(
            recordAuthenticationFailure("login-password", subject, thirdFailureAt)
        ).toEqual({ allowed: false, retryAfterSeconds: 15 });
        expect(
            authenticationThrottleStatus("login-password", subject, blockedCheckAt)
        ).toEqual({ allowed: false, retryAfterSeconds: 14 });

        const stored = database
            .prepare(
                `SELECT bucket_key, failure_count
                 FROM auth_rate_limit_buckets`
            )
            .get() as { bucket_key: string; failure_count: number };
        expect(stored.bucket_key).toMatch(/^[a-f0-9]{64}$/u);
        expect(stored.bucket_key).not.toContain(subject);
        expect(stored.failure_count).toBe(3);

        clearAuthenticationFailures("login-password", subject);
        expect(
            authenticationThrottleStatus("login-password", subject, blockedCheckAt)
        ).toEqual({ allowed: true });
    });

    it("enrolls TOTP, returns recovery codes once, and protects account changes", async () => {
        configureMfaEncryption();
        const user = await createUser(`${USER_PREFIX}account-routes`, "initial-password");
        const server = {
            requestIP: () => ({
                address: "203.0.113.30",
                family: "IPv4",
                port: 31_000,
            }),
        } as unknown as Server<unknown>;
        let cookie = `mira_dashboard_session=${createSession(user.id)}`;

        const setup = await accountSecurityRoutes[
            "/api/account/security/totp/setup"
        ].POST(
            accountSecurityRequest("/api/account/security/totp/setup", cookie, {
                label: "Phone authenticator",
            }),
            server
        );
        expect(setup.status).toBe(201);
        const enrollment = (await setup.json()) as {
            enrollment: {
                factorId: string;
                secret: string;
            };
        };
        const token = await generate({
            algorithm: "sha1",
            digits: 6,
            period: 30,
            secret: enrollment.enrollment.secret,
            strategy: "totp",
        });
        const confirmation = await accountSecurityRoutes[
            "/api/account/security/totp/confirm"
        ].POST(
            accountSecurityRequest("/api/account/security/totp/confirm", cookie, {
                code: token,
                factorId: enrollment.enrollment.factorId,
            }),
            server
        );
        expect(confirmation.status).toBe(200);
        const confirmed = (await confirmation.json()) as {
            recoveryCodes: string[];
        };
        expect(confirmed.recoveryCodes).toHaveLength(10);
        cookie = sessionCookieHeader(confirmation);

        const summary = accountSecurityRoutes["/api/account/security"].GET(
            accountSecurityRequest("/api/account/security", cookie),
            server
        );
        await expect(summary.json()).resolves.toMatchObject({
            factors: {
                recoveryCodesRemaining: 10,
                totpFactors: [
                    {
                        id: enrollment.enrollment.factorId,
                        label: "Phone authenticator",
                    },
                ],
            },
            recommendation: { minimumSecurityKeys: 2 },
        });

        const finalFactorRemoval = accountSecurityRoutes[
            "/api/account/security/totp/:factorId"
        ].DELETE(
            Object.assign(
                accountSecurityRequest(
                    `/api/account/security/totp/${enrollment.enrollment.factorId}`,
                    cookie,
                    undefined,
                    "DELETE"
                ),
                {
                    params: {
                        factorId: enrollment.enrollment.factorId,
                    },
                }
            ),
            server
        );
        expect(finalFactorRemoval.status).toBe(409);

        const stepUp = await accountSecurityRoutes[
            "/api/account/security/step-up/recovery"
        ].POST(
            accountSecurityRequest("/api/account/security/step-up/recovery", cookie, {
                code: confirmed.recoveryCodes[0],
            }),
            server
        );
        expect(stepUp.status).toBe(200);
        cookie = sessionCookieHeader(stepUp);

        const disable = await accountSecurityRoutes[
            "/api/account/security/mfa/disable"
        ].POST(
            accountSecurityRequest("/api/account/security/mfa/disable", cookie, {
                password: "initial-password",
            }),
            server
        );
        expect(disable.status).toBe(200);
        cookie = sessionCookieHeader(disable);
        expect(findUserById(user.id)?.mfa_enabled_at).toBeNull();
        const storedSecrets = database
            .prepare(
                `SELECT
                    (SELECT COUNT(*) FROM user_totp_factors WHERE user_id = ?) AS totp,
                    (SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = ?) AS recovery`
            )
            .get(user.id, user.id);
        expect(storedSecrets).toEqual({ recovery: 0, totp: 0 });
        const sessionToken = decodeURIComponent(cookie.split("=", 2)[1] ?? "");
        const session = getAuthSessionFromSessionId(sessionToken);
        expect(session?.mfaEnabled).toBe(false);
    });

    it("requires enrolled and recent MFA for privileged browser actions", async () => {
        const user = await createUser(`${USER_PREFIX}step-up`, "initial-password");
        const server = {
            requestIP: () => ({
                address: "203.0.113.25",
                family: "IPv4",
                port: 31_000,
            }),
        } as unknown as Server<unknown>;
        const handler = (request: Request, server: Server<unknown>) => {
            void request;
            void server;
            return Response.json({ isOk: true });
        };
        const routes = withRequestPolicy({
            "/api/restart": { POST: handler },
        });
        const request = (sessionToken: string) =>
            new Request("https://dashboard.example/api/restart", {
                headers: {
                    cookie: `mira_dashboard_session=${encodeURIComponent(sessionToken)}`,
                    origin: "https://dashboard.example",
                    "sec-fetch-site": "same-origin",
                },
                method: "POST",
            });

        const passwordSession = createSession(user.id);
        const enrollmentRequired = await routes["/api/restart"].POST(
            request(passwordSession),
            server
        );
        expect(enrollmentRequired.status).toBe(403);
        await expect(enrollmentRequired.json()).resolves.toMatchObject({
            code: "mfa_enrollment_required",
        });

        const timestamp = new Date().toISOString();
        database
            .prepare(
                `UPDATE users
                 SET mfa_enabled_at = ?, updated_at = ?
                 WHERE id = ?`
            )
            .run(timestamp, timestamp, user.id);
        const staleSession = createSession(user.id, {
            authMethod: "webauthn",
            mfaVerifiedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        });
        const stale = await routes["/api/restart"].POST(request(staleSession), server);
        expect(stale.status).toBe(403);
        await expect(stale.json()).resolves.toMatchObject({
            code: "step_up_required",
        });

        const verifiedSession = createSession(user.id, {
            authMethod: "webauthn",
            mfaVerifiedAt: timestamp,
        });
        const accepted = await routes["/api/restart"].POST(
            request(verifiedSession),
            server
        );
        expect(accepted.status).toBe(200);
        expect(
            requiresRecentMfa(
                new Request(
                    "https://dashboard.example/api/config-files/openclaw.json?reveal=1"
                )
            )
        ).toBe(true);
        expect(
            requiresRecentMfa(new Request("https://dashboard.example/api/tasks"))
        ).toBe(false);
        expect(
            requiresRecentMfa(
                new Request("https://dashboard.example/api/cache/system.host/refresh", {
                    method: "POST",
                })
            )
        ).toBe(true);
        expect(
            requiresRecentMfa(
                new Request("https://dashboard.example/api/settings", {
                    method: "PUT",
                })
            )
        ).toBe(true);
        expect(
            requiresRecentMfa(
                new Request("https://dashboard.example/api/terminal/complete", {
                    method: "POST",
                })
            )
        ).toBe(true);
        expect(
            requiresRecentMfa(
                new Request(
                    "https://dashboard.example/api/config-files/openclaw%2ejson?reveal=1"
                )
            )
        ).toBe(true);
        expect(
            requiresRecentMfa(
                new Request("https://dashboard.example/api/%74erminal/complete", {
                    method: "POST",
                })
            )
        ).toBe(true);
    });

    it("masks reusable config secrets and restores placeholders only server-side", () => {
        const current = {
            channels: {
                discord: {
                    cookie: "session-secret",
                    enabled: true,
                    token: "discord-secret",
                },
            },
            storage: {
                backupEncryptionKey: "backup-secret",
                seed: "seed-secret",
            },
            gateway: { auth: { password: "gateway-secret" } },
        };
        const redacted = redactConfigSecrets(current);
        expect(redacted).toEqual({
            channels: {
                discord: {
                    cookie: CONFIG_REDACTION_SENTINEL,
                    enabled: true,
                    token: CONFIG_REDACTION_SENTINEL,
                },
            },
            storage: {
                backupEncryptionKey: CONFIG_REDACTION_SENTINEL,
                seed: CONFIG_REDACTION_SENTINEL,
            },
            gateway: {
                auth: { password: CONFIG_REDACTION_SENTINEL },
            },
        });
        const restored = restoreConfigRedactionSentinels(
            {
                channels: {
                    discord: {
                        enabled: false,
                        token: CONFIG_REDACTION_SENTINEL,
                    },
                },
            },
            current
        );
        expect(restored).toEqual({
            channels: {
                discord: {
                    enabled: false,
                    token: "discord-secret",
                },
            },
        });
        expect(hasConfigRedactionSentinel(restored)).toBe(false);
        expect(
            hasConfigRedactionSentinel(
                restoreConfigRedactionSentinels({ token: CONFIG_REDACTION_SENTINEL }, {})
            )
        ).toBe(true);
        const maskedJson = redactConfigJsonText(JSON.stringify(current));
        expect(maskedJson).not.toContain("discord-secret");
        expect(maskedJson).not.toContain("backup-secret");
        expect(maskedJson).not.toContain("gateway-secret");
        expect(maskedJson).not.toContain("seed-secret");
        expect(redactConfigJsonText("{")).toBeUndefined();
    });
});
