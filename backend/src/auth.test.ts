import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
    bootstrapRequired,
    clearSessionCookie,
    createSession,
    createUser,
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

        const user = createUser("  Raymond  ", "secret");
        assert.equal(user.username, "raymond");
        assert.equal(bootstrapRequired(), false);

        persistGatewayToken("gateway-token");
        assert.equal(getPersistedGatewayToken(), "gateway-token");
        persistGatewayToken("updated-token");
        assert.equal(getPersistedGatewayToken(), "updated-token");

        const sessionId = createSession(user.id);
        assert.equal(getAuthUserFromSessionId(sessionId)?.username, "raymond");

        db.prepare("UPDATE auth_sessions SET expires_at = ? WHERE id = ?").run(
            new Date(Date.now() - 1000).toISOString(),
            sessionId
        );
        assert.equal(getAuthUserFromSessionId(sessionId), null);
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
