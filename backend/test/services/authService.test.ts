import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import { createServiceBehaviorHarness } from "../support/serviceBehaviorHarness";
describe("backend auth services", () => {
    const { cleanupCallbacks, rememberEnvironment } = createServiceBehaviorHarness();
    it("handles auth hashing, users, sessions, and gateway tokens", async () => {
        const username = `User-${Bun.randomUUIDv7()}`;
        const normalizedUsername = username.toLowerCase();
        const {
            cleanupExpiredSessions,
            createSession,
            createFirstUser,
            createUser,
            didDeletePersistedGatewayTokenIfMatches,
            deleteSession,
            findUserByUsername,
            getAuthUserFromSessionId,
            getPersistedGatewayToken,
            hashPassword,
            recentAuthenticationTtlMs,
            sessionIdleTtlMs,
            validateAuthenticationConfig,
            validateStoredSecretConfig,
            verifyPassword,
            persistGatewayToken,
        } = await Promise.all([
            import("../../src/auth/sessionRepository.ts"),
            import("../../src/auth/sessionPolicy.ts"),
            import("../../src/auth/userRepository.ts"),
        ]).then(([sessionRepository, sessionPolicy, userRepository]) => ({
            cleanupExpiredSessions: sessionRepository.cleanupExpiredSessions,
            createSession: sessionRepository.createSession,
            createFirstUser: userRepository.createFirstUser,
            createUser: userRepository.createUser,
            didDeletePersistedGatewayTokenIfMatches:
                userRepository.didDeletePersistedGatewayTokenIfMatches,
            deleteSession: sessionRepository.deleteSession,
            findUserByUsername: userRepository.findUserByUsername,
            getAuthUserFromSessionId: sessionRepository.getAuthUserFromSessionId,
            getPersistedGatewayToken: userRepository.getPersistedGatewayToken,
            hashPassword: userRepository.hashPassword,
            recentAuthenticationTtlMs: sessionPolicy.recentAuthenticationTtlMs,
            sessionIdleTtlMs: sessionPolicy.sessionIdleTtlMs,
            validateAuthenticationConfig: sessionPolicy.validateAuthenticationConfig,
            validateStoredSecretConfig: userRepository.validateStoredSecretConfig,
            verifyPassword: userRepository.verifyPassword,
            persistGatewayToken: userRepository.persistGatewayToken,
        }));
        rememberEnvironment("MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY");
        const configuredSecretEncryptionKey =
            process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;
        if (!configuredSecretEncryptionKey) {
            throw new Error("Test secret-encryption key was not configured");
        }
        try {
            const hash = await hashPassword("correct horse battery staple");
            expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
            expect(await verifyPassword("wrong password", hash)).toBe(false);
            expect(await verifyPassword("password", "not-a-valid-hash")).toBe(false);
            expect(sessionIdleTtlMs()).toBe(30 * 60_000);
            expect(recentAuthenticationTtlMs()).toBe(10 * 60_000);
            expect(sessionIdleTtlMs("5")).toBe(5 * 60_000);
            expect(recentAuthenticationTtlMs("60")).toBe(60 * 60_000);
            expect(() => sessionIdleTtlMs("4")).toThrow();
            expect(() => recentAuthenticationTtlMs("61")).toThrow();
            expect(() => sessionIdleTtlMs("not-a-number")).toThrow();
            expect(() => recentAuthenticationTtlMs("1.5")).toThrow();
            expect(validateAuthenticationConfig()).toBeUndefined();
            expect(validateStoredSecretConfig()).toBeUndefined();
            delete process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY;
            expect(() => validateStoredSecretConfig()).toThrow(
                "MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY is not configured"
            );
            process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY =
                configuredSecretEncryptionKey;
            const user = await createUser(username, "test-password");
            expect(user).toMatchObject({
                username: normalizedUsername,
            });
            const originalHashPassword = Bun.password.hash.bind(Bun.password);
            cleanupCallbacks.push(() => {
                Bun.password.hash = originalHashPassword;
            });
            Bun.password.hash = () => {
                throw new Error("Password hashing should not run after bootstrap closes");
            };
            expect(
                createFirstUser(`first-${username}`, "correct-password")
            ).resolves.toBeUndefined();
            Bun.password.hash = originalHashPassword;
            expect(findUserByUsername(`  ${username.toUpperCase()}  `)).toMatchObject({
                id: user.id,
                username: normalizedUsername,
            });
            const sessionId = createSession(user.id);
            expect(sessionId).toMatch(/^[a-f0-9]{32}\.[a-f0-9]{64}$/u);
            const sessionSelector = sessionId.split(".", 1)[0] as string;
            const storedSession = database
                .prepare(`SELECT id, validator_hash
                     FROM auth_sessions
                     WHERE id = ?`)
                .get(sessionSelector) as {
                id: string;
                validator_hash: string;
            };
            expect(storedSession.id).toBe(sessionSelector);
            expect(storedSession.validator_hash).toMatch(/^[a-f0-9]{64}$/u);
            expect(storedSession.validator_hash).not.toBe(sessionId.split(".", 2)[1]);
            expect(getAuthUserFromSessionId(sessionId)).toEqual(user);
            const wrongSessionId = `${sessionId.slice(0, -1)}${sessionId.endsWith("a") ? "b" : "a"}`;
            expect(getAuthUserFromSessionId(wrongSessionId)).toBeUndefined();
            deleteSession(sessionId);
            expect(getAuthUserFromSessionId(sessionId)).toBeUndefined();
            const expiredSessionId = createSession(user.id);
            const expiredSessionSelector = expiredSessionId.split(".", 1)[0] as string;
            database
                .prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?")
                .run("2000-01-01T00:00:00.000Z", expiredSessionSelector);
            cleanupExpiredSessions();
            expect(getAuthUserFromSessionId(expiredSessionId)).toBeUndefined();
            const malformedSessionId = "a".repeat(64);
            database
                .prepare(`INSERT INTO auth_sessions (
                        id, user_id, created_at, expires_at, validator_hash
                     ) VALUES (?, ?, ?, ?, NULL)`)
                .run(
                    malformedSessionId,
                    user.id,
                    "2026-07-23T00:00:00.000Z",
                    "2099-01-01T00:00:00.000Z"
                );
            expect(getAuthUserFromSessionId(malformedSessionId)).toBeUndefined();
            deleteSession(malformedSessionId);
            expect(getAuthUserFromSessionId(malformedSessionId)).toBeUndefined();
            persistGatewayToken("token-one");
            expect(getPersistedGatewayToken()).toBe("token-one");
            const encryptedGatewayToken = database
                .prepare("SELECT value FROM app_config WHERE key = 'gateway_token'")
                .get() as {
                value: string;
            };
            expect(encryptedGatewayToken.value).toStartWith("v1.");
            expect(encryptedGatewayToken.value).not.toContain("token-one");
            process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY = new Uint8Array(32)
                .fill(8)
                .toBase64();
            expect(() => validateStoredSecretConfig()).toThrow(
                "Failed to decrypt stored secret"
            );
            process.env.MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY =
                configuredSecretEncryptionKey;
            expect(validateStoredSecretConfig()).toBeUndefined();
            persistGatewayToken("token-two");
            expect(getPersistedGatewayToken()).toBe("token-two");
            expect(didDeletePersistedGatewayTokenIfMatches("wrong-token")).toBe(false);
            expect(didDeletePersistedGatewayTokenIfMatches("token-two")).toBe(true);
            expect(getPersistedGatewayToken()).toBeUndefined();
            database
                .prepare(`INSERT INTO app_config (key, value, updated_at)
                     VALUES ('gateway_token', ?, ?)`)
                .run("malformed-stored-secret", new Date().toISOString());
            expect(() => getPersistedGatewayToken()).toThrow(
                "Unsupported stored-secret envelope"
            );
        } finally {
            database
                .prepare(
                    "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username = ?)"
                )
                .run(normalizedUsername);
            database
                .prepare("DELETE FROM users WHERE username = ?")
                .run(normalizedUsername);
            database.prepare("DELETE FROM app_config WHERE key = 'gateway_token'").run();
        }
    });
    it("keeps the active test database usable after a rejected rebind", () => {
        rememberEnvironment("MIRA_DASHBOARD_DB_PATH");
        const originalDatabasePath = process.env.MIRA_DASHBOARD_DB_PATH;
        expect(database.prepare("SELECT 1 AS value").get()).toEqual({
            value: 1,
        });
        process.env.MIRA_DASHBOARD_DB_PATH = path.join(
            path.parse(tmpdir()).root,
            "mira-dashboard-non-temporary-test",
            `unsafe-${Bun.randomUUIDv7()}.db`
        );
        expect(() => database.prepare("SELECT 1").get()).toThrow(
            "Refusing to open non-temporary Dashboard test database"
        );
        if (originalDatabasePath === undefined) {
            delete process.env.MIRA_DASHBOARD_DB_PATH;
        } else {
            process.env.MIRA_DASHBOARD_DB_PATH = originalDatabasePath;
        }
        expect(database.prepare("SELECT 1 AS value").get()).toEqual({
            value: 1,
        });
    });
});
