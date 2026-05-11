import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import { createUser } from "../auth.js";
import { db } from "../db.js";
import authRoutes from "./auth.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    authRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: T; headers: Headers }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.body === undefined
                ? options.headers
                : { "Content-Type": "application/json", ...options.headers },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
        headers: response.headers,
    };
}

function cleanupUser(username: string): void {
    const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username) as
        | { id: number }
        | undefined;
    if (!user) {
        return;
    }

    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
    db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
}

describe("auth routes", () => {
    const username = `backend-route-${Date.now()}`;
    const password = "correct horse battery staple";
    let server: TestServer;

    before(async () => {
        cleanupUser(username);
        createUser(username, password);
        server = await startServer();
    });

    after(async () => {
        await server.close();
        cleanupUser(username);
    });

    it("reports bootstrap state without exposing secrets", async () => {
        const response = await requestJson<{
            bootstrapRequired: boolean;
            hasGatewayToken: boolean;
        }>(server, "/api/auth/bootstrap");

        assert.equal(response.status, 200);
        assert.equal(response.body.bootstrapRequired, false);
        assert.equal(typeof response.body.hasGatewayToken, "boolean");
    });

    it("rejects malformed and invalid login attempts", async () => {
        const malformed = await requestJson<{ error: string }>(
            server,
            "/api/auth/login",
            {
                method: "POST",
                body: { username: "no", password },
            }
        );

        assert.equal(malformed.status, 400);
        assert.equal(malformed.body.error, "Username and password are required");

        const invalid = await requestJson<{ error: string }>(server, "/api/auth/login", {
            method: "POST",
            body: { username, password: "wrong password" },
        });

        assert.equal(invalid.status, 401);
        assert.equal(invalid.body.error, "Invalid username or password");
    });

    it("logs in with normalized usernames and clears sessions on logout", async () => {
        const login = await requestJson<{
            authenticated: boolean;
            user: { id: number; username: string };
        }>(server, "/api/auth/login", {
            method: "POST",
            body: { username: `  ${username.toUpperCase()}  `, password },
        });

        assert.equal(login.status, 200);
        assert.equal(login.body.authenticated, true);
        assert.equal(login.body.user.username, username);

        const cookie = login.headers.get("set-cookie") || "";
        assert.match(cookie, /mira_dashboard_session=/u);
        assert.match(cookie, /HttpOnly/u);
        assert.match(cookie, /SameSite=Strict/u);

        const sessionId = cookie.match(/mira_dashboard_session=([^;]+)/u)?.[1];
        assert.ok(sessionId);
        assert.equal(
            Boolean(
                db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sessionId)
            ),
            true
        );

        const logout = await requestJson<{ ok: true }>(server, "/api/auth/logout", {
            method: "POST",
            headers: { cookie: `mira_dashboard_session=${sessionId}` },
        });

        assert.equal(logout.status, 200);
        assert.deepEqual(logout.body, { ok: true });
        assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/u);
        assert.equal(
            Boolean(
                db.prepare("SELECT id FROM auth_sessions WHERE id = ?").get(sessionId)
            ),
            false
        );
    });
});
