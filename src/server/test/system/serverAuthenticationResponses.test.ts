import { afterEach, describe, expect, test } from "bun:test";

import { createServer, type ApplicationServer } from "../../../app/server.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { generateOpaqueToken } from "../../shared/opaqueToken.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestAuthenticationResolution,
    createTestServerSecurityServices,
    createTestSessionAuthentication,
    testSecurityUserId,
    testSessionSelector,
} from "../support/requestContext.ts";

const servers: ApplicationServer[] = [];
const session = Object.freeze({
    authenticatedAtMs: 1_800_000_000_000,
    authMethod: "password" as const,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_802_592_000_000,
    id: testSessionSelector,
    isCurrent: true,
    lastSeenAtMs: 1_800_000_000_000,
});
const user = Object.freeze({
    email: "operator@example.com",
    id: testSecurityUserId,
    username: "operator",
});

afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop(true);
});

describe("authentication HTTP responses", () => {
    test("delivers a one-time token only through Fetch-adapter response headers", async () => {
        const generated = generateOpaqueToken("session");
        const server = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () =>
                    Promise.resolve({
                        session,
                        status: "created",
                        token: generated.token,
                        user,
                    }),
            }),
            authenticateCredential: () => ({ authentication: { kind: "anonymous" } }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(server);
        const response = await fetch(new URL("/trpc/auth.login", server.url), {
            body: JSON.stringify({
                json: { password: "correct-horse-battery", username: "operator" },
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });
        const responseText = await response.text();

        expect(response.status).toBe(200);
        expect(responseText).toContain('"username":"operator"');
        expect(responseText).not.toContain(generated.token);
        expect(response.headers.get("set-cookie")).toContain(
            `__Host-mira_dashboard_session=${generated.token}`
        );
        expect(response.headers.get("cache-control")).toContain("no-store");
    });

    test("delivers Retry-After and cookie clearing through real Fetch responses", async () => {
        const rateLimitedServer = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                login: () =>
                    Promise.resolve({ retryAfterSeconds: 23, status: "rate-limited" }),
            }),
            authenticateCredential: () => ({ authentication: { kind: "anonymous" } }),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(rateLimitedServer);
        const rateLimited = await fetch(
            new URL("/trpc/auth.login", rateLimitedServer.url),
            {
                body: JSON.stringify({
                    json: {
                        password: "correct-horse-battery",
                        username: "operator",
                    },
                }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }
        );

        expect(rateLimited.status).toBe(429);
        expect(rateLimited.headers.get("retry-after")).toBe("23");
        expect(rateLimited.headers.get("cache-control")).toContain("no-store");

        const sessionChangedServer = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                changePassword: () => Promise.resolve({ status: "session-changed" }),
            }),
            authenticateCredential: () =>
                createTestAuthenticationResolution(
                    createTestSessionAuthentication(["reports:read"])
                ),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(sessionChangedServer);
        const sessionChanged = await fetch(
            new URL("/trpc/auth.changePassword", sessionChangedServer.url),
            {
                body: JSON.stringify({
                    json: {
                        currentPassword: "correct-horse-battery",
                        newPassword: "another-correct-horse",
                    },
                }),
                headers: {
                    "content-type": "application/json",
                    cookie: `__Host-mira_dashboard_session=${generateOpaqueToken("session").token}`,
                },
                method: "POST",
            }
        );

        expect(sessionChanged.status).toBe(401);
        expect(sessionChanged.headers.get("set-cookie")).toContain("Max-Age=0");
        expect(sessionChanged.headers.get("cache-control")).toContain("no-store");

        const stepUpServer = await createServer({
            ...createTestServerSecurityServices(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationLifecycle: createTestAuthenticationLifecycleService({
                changePassword: () => Promise.resolve({ status: "step-up-required" }),
            }),
            authenticateCredential: () =>
                createTestAuthenticationResolution(
                    createTestSessionAuthentication(["reports:read"])
                ),
            hostname: "127.0.0.1",
            port: 0,
            readiness: createReadinessController(),
        });
        servers.push(stepUpServer);
        const stepUpRequired = await fetch(
            new URL("/trpc/auth.changePassword", stepUpServer.url),
            {
                body: JSON.stringify({
                    json: {
                        currentPassword: "correct-horse-battery",
                        newPassword: "another-correct-horse",
                    },
                }),
                headers: {
                    "content-type": "application/json",
                    cookie: `__Host-mira_dashboard_session=${generateOpaqueToken("session").token}`,
                },
                method: "POST",
            }
        );
        const stepUpBody = await stepUpRequired.text();

        expect(stepUpRequired.status).toBe(403);
        expect(stepUpBody).toContain('"reason":"step_up_required"');
        expect(stepUpRequired.headers.get("set-cookie")).toBeNull();
        expect(stepUpRequired.headers.get("cache-control")).toContain("no-store");
    });
});
