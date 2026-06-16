import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import {
    bootstrapRequired,
    clearSessionCookie,
    createFirstUser,
    createSession,
    createUser,
    findUserByUsername,
    getAuthUserFromRequest,
    getAuthUserFromSessionId,
    getPersistedGatewayToken,
    hashPassword,
    isLoopbackRequest,
    persistGatewayToken,
    requireAuth,
    setSessionCookie,
    verifyPassword,
} from "./auth.js";
import { db } from "./db.js";

describe("auth helpers", () => {
    beforeEach(() => {
        db.exec("DELETE FROM auth_sessions; DELETE FROM users; DELETE FROM app_config;");
    });

    it("hashes passwords with unique salts and verifies only the matching secret", () => {
        const firstHash = hashPassword("correct horse battery staple");
        const secondHash = hashPassword("correct horse battery staple");

        assert.match(firstHash, /^scrypt:[\da-f]+:[\da-f]+$/);
        assert.notEqual(firstHash, secondHash);
        assert.equal(verifyPassword("correct horse battery staple", firstHash), true);
        assert.equal(verifyPassword("wrong password", firstHash), false);
    });

    it("rejects malformed or incompatible password hashes", () => {
        assert.equal(verifyPassword("secret", ""), false);
        assert.equal(verifyPassword("secret", "bcrypt:salt:hash"), false);
        assert.equal(verifyPassword("secret", "scrypt:salt:abcd"), false);
    });

    it("recognizes loopback requests only", () => {
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "127.0.0.1" } } as never),
            true
        );
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "::1" } } as never),
            true
        );
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } } as never),
            true
        );
        assert.equal(
            isLoopbackRequest({ socket: { remoteAddress: "10.0.0.5" } } as never),
            false
        );
        assert.equal(isLoopbackRequest({ socket: {} } as never), false);
    });

    it("creates users, sessions, and persisted gateway tokens", () => {
        assert.equal(bootstrapRequired(), true);
        assert.equal(findUserByUsername("nobody"), null);
        assert.equal(getAuthUserFromSessionId("missing-session"), null);

        const user = createUser("  Raymond  ", "secret");
        assert.equal(user.username, "raymond");
        assert.equal(bootstrapRequired(), false);

        persistGatewayToken("gateway-token");
        assert.equal(getPersistedGatewayToken(), "gateway-token");
        persistGatewayToken("updated-token");
        assert.equal(getPersistedGatewayToken(), "updated-token");

        const sessionId = createSession(user.id);
        assert.equal(getAuthUserFromSessionId(sessionId)?.username, "raymond");

        const expiredAt = new Date(Date.now() - 1000);
        db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?").run(
            expiredAt.toISOString(),
            sessionId
        );
        assert.equal(getAuthUserFromSessionId(sessionId), null);
    });

    it("rolls back atomic first-user creation failures", () => {
        const originalPrepare = db.prepare.bind(db);
        const prepareMock = mock.method(db, "prepare", (sql: string) => {
            if (sql.includes("INSERT INTO users")) {
                return {
                    run() {
                        throw new Error("insert failed");
                    },
                } as never;
            }
            return originalPrepare(sql);
        });
        try {
            assert.throws(() => createFirstUser("first", "secret"), /insert failed/u);
            assert.equal(bootstrapRequired(), true);
        } finally {
            prepareMock.mock.restore();
        }
    });

    it("surfaces first-user rollback cleanup failures", () => {
        const originalPrepare = db.prepare.bind(db);
        const originalExec = db.exec.bind(db);
        const prepareMock = mock.method(db, "prepare", (sql: string) => {
            if (sql.includes("INSERT INTO users")) {
                return { run: () => ({ changes: 0 }) } as never;
            }
            return originalPrepare(sql);
        });
        const execMock = mock.method(db, "exec", (sql: string) => {
            if (sql === "ROLLBACK") {
                throw new Error("rollback failed");
            }
            return originalExec(sql);
        });
        try {
            assert.throws(() => createFirstUser("first", "secret"), /rollback failed/u);
        } finally {
            execMock.mock.restore();
            prepareMock.mock.restore();
            try {
                originalExec("ROLLBACK");
            } catch {
                // No transaction remains when rollback succeeded unexpectedly.
            }
        }
    });

    it("reads auth users from loopback and session cookies", () => {
        const user = createUser("Mira", "secret");
        const sessionId = createSession(user.id);

        assert.deepEqual(
            getAuthUserFromRequest({
                socket: { remoteAddress: "127.0.0.1" },
                headers: {},
            } as never),
            { id: 0, username: "mira-local" }
        );
        assert.equal(
            getAuthUserFromRequest({
                socket: { remoteAddress: "10.0.0.5" },
                headers: { cookie: `other=value; mira_dashboard_session=${sessionId}` },
            } as never)?.username,
            "mira"
        );
        assert.equal(
            getAuthUserFromRequest({
                socket: { remoteAddress: "10.0.0.5" },
                headers: { cookie: "malformed; mira_dashboard_session=" },
            } as never),
            null
        );
    });

    it("sets and clears secure session cookies", () => {
        const headers = new Map<string, string>();
        const response = {
            setHeader: (key: string, value: string) => headers.set(key, value),
        };
        const request = {
            headers: { "x-forwarded-proto": "https, http" },
        };

        setSessionCookie(response as never, "session id", request as never);
        assert.match(
            headers.get("Set-Cookie") || "",
            /mira_dashboard_session=session%20id/u
        );
        assert.match(headers.get("Set-Cookie") || "", /Secure/u);

        clearSessionCookie(response as never, request as never);
        assert.match(headers.get("Set-Cookie") || "", /Max-Age=0/u);
        assert.match(headers.get("Set-Cookie") || "", /Secure/u);
    });

    it("requires authenticated requests before continuing", () => {
        let statusCode = 0;
        let body: unknown;
        let nextCalled = false;
        const response = {
            status: (code: number) => {
                statusCode = code;
                return response;
            },
            json: (payload: unknown) => {
                body = payload;
                return response;
            },
        };

        requireAuth(
            { socket: { remoteAddress: "10.0.0.5" }, headers: {} } as never,
            response as never,
            () => {
                nextCalled = true;
            }
        );
        assert.equal(statusCode, 401);
        assert.deepEqual(body, { error: "Unauthorized" });
        assert.equal(nextCalled, false);

        const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} } as {
            socket: { remoteAddress: string };
            headers: Record<string, string>;
            user?: { id: number; username: string };
        };
        requireAuth(request as never, response as never, () => {
            nextCalled = true;
        });
        assert.equal(nextCalled, true);
        assert.deepEqual(request.user, { id: 0, username: "mira-local" });
    });
});
