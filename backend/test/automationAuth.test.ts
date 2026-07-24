import type { Server } from "bun";
import { afterEach, describe, expect, it, jest } from "bun:test";

import {
    authenticateAutomationRequest,
    type AutomationScope,
    requiredAutomationScope,
    validateAutomationCredentials,
} from "../src/automationAuth.ts";
import { database } from "../src/database.ts";
import { resetRequestPolicyForTests, withRequestPolicy } from "../src/requestPolicy.ts";

const WRITER_VALIDATOR = "a1".repeat(32);
const READER_VALIDATOR = "b2".repeat(32);

function hashValidator(validator: string): string {
    return new Bun.CryptoHasher("sha256").update(validator).digest("hex");
}

function credentialsJson(): string {
    return JSON.stringify([
        {
            id: "mira-writer",
            scopes: ["tasks:read", "tasks:write", "reports:write", "agents:write"],
            tokenHash: hashValidator(WRITER_VALIDATOR),
        },
        {
            id: "mira-reader",
            scopes: ["tasks:read", "cache:read"],
            tokenHash: hashValidator(READER_VALIDATOR),
        },
    ]);
}

function authorization(id: string, validator: string): string {
    return `Bearer ${id}.${validator}`;
}

function request(
    pathname: string,
    method = "GET",
    authorizationHeader?: string
): Request {
    return new Request(`http://localhost${pathname}`, {
        headers: authorizationHeader ? { authorization: authorizationHeader } : undefined,
        method,
    });
}

function loopbackServer(): Server<unknown> {
    return {
        requestIP: () => ({
            address: "127.0.0.1",
            family: "IPv4",
            port: 31_000,
        }),
    } as unknown as Server<unknown>;
}

interface AuditRow {
    action: string;
    actor_id: string;
    actor_type: string;
    metadata_json: string;
    outcome: string;
}

function auditRows(requestId: string | null): AuditRow[] {
    if (!requestId) throw new Error("Missing response request ID");
    return database
        .prepare(
            `SELECT actor_type, actor_id, action, outcome, metadata_json
             FROM audit_events
             WHERE request_id = ?
             ORDER BY rowid`
        )
        .all(requestId) as AuditRow[];
}

afterEach(() => {
    resetRequestPolicyForTests();
});

describe("scoped automation authentication", () => {
    it("validates hash-only credentials and authenticates strict bearer tokens", () => {
        const serialized = credentialsJson();
        const writerAuthorization = authorization("mira-writer", WRITER_VALIDATOR);
        const wrongWriterAuthorization = authorization("mira-writer", "c3".repeat(32));
        expect(validateAutomationCredentials()).toBe(0);
        expect(validateAutomationCredentials(" ".repeat(3))).toBe(0);
        expect(validateAutomationCredentials(serialized)).toBe(2);
        expect(
            authenticateAutomationRequest(
                request("/api/tasks", "GET", writerAuthorization),
                serialized
            )
        ).toMatchObject({
            kind: "authenticated",
            principal: { id: "mira-writer" },
        });
        const authenticated = authenticateAutomationRequest(
            request("/api/tasks", "GET", authorization("mira-reader", READER_VALIDATOR)),
            serialized
        );
        expect(authenticated.kind).toBe("authenticated");
        if (authenticated.kind === "authenticated") {
            expect([...authenticated.principal.scopes]).toEqual([
                "tasks:read",
                "cache:read",
            ]);
        }
        expect(
            authenticateAutomationRequest(
                request("/api/tasks", "GET", wrongWriterAuthorization),
                serialized
            )
        ).toEqual({ kind: "invalid" });
        expect(authenticateAutomationRequest(request("/api/tasks"), serialized)).toEqual({
            kind: "absent",
        });
        expect(
            authenticateAutomationRequest(
                request("/api/tasks", "GET", "Basic ignored-by-dashboard"),
                serialized
            )
        ).toEqual({ kind: "absent" });
        expect(
            authenticateAutomationRequest(
                request("/api/tasks", "GET", "Bearer"),
                serialized
            )
        ).toEqual({ kind: "invalid" });
        expect(
            authenticateAutomationRequest(
                request("/api/tasks", "GET", `Bearer  mira-writer.${WRITER_VALIDATOR}`),
                serialized
            )
        ).toEqual({ kind: "invalid" });
        expect(
            authenticateAutomationRequest(
                request("/api/tasks", "GET", `Bearer\tmira-writer.${WRITER_VALIDATOR}`),
                serialized
            )
        ).toEqual({ kind: "invalid" });
    });

    it("fails closed on malformed, duplicate, or unknown credential config", () => {
        const validHash = hashValidator(WRITER_VALIDATOR);
        const invalidConfigurations = [
            "not-json",
            "[]",
            JSON.stringify([
                {
                    id: "mira",
                    scopes: ["tasks:unknown"],
                    tokenHash: validHash,
                },
            ]),
            JSON.stringify([
                {
                    extra: true,
                    id: "mira",
                    scopes: ["tasks:read"],
                    tokenHash: validHash,
                },
            ]),
            JSON.stringify([
                {
                    id: "mira",
                    scopes: ["tasks:read", "tasks:read"],
                    tokenHash: validHash,
                },
            ]),
            JSON.stringify([
                {
                    id: "mira",
                    scopes: ["tasks:read"],
                    tokenHash: validHash,
                },
                {
                    id: "mira",
                    scopes: ["cache:read"],
                    tokenHash: hashValidator(READER_VALIDATOR),
                },
            ]),
            JSON.stringify([
                {
                    id: "mira-one",
                    scopes: ["tasks:read"],
                    tokenHash: validHash,
                },
                {
                    id: "mira-two",
                    scopes: ["cache:read"],
                    tokenHash: validHash,
                },
            ]),
        ];
        for (const serialized of invalidConfigurations) {
            expect(() => validateAutomationCredentials(serialized)).toThrow();
        }
    });

    it("maps only explicitly approved route families to automation scopes", () => {
        const cases: Array<[string, string, AutomationScope | undefined]> = [
            ["GET", "/api/tasks", "tasks:read"],
            ["DELETE", "/api/tasks/42", "tasks:write"],
            ["POST", "/api/reports", "reports:write"],
            ["GET", "/api/notifications", "notifications:read"],
            ["PUT", "/api/agents/main/metadata", "agents:write"],
            ["GET", "/api/agents/config", "agents:read"],
            ["GET", "/api/agents/status", "agents:write"],
            ["GET", "/api/agents/main/status", "agents:write"],
            ["GET", "/api/agents/tasks/history", "agents:write"],
            ["GET", "/api/agents/unknown", undefined],
            ["GET", "/api/audit-events", "audit:read"],
            ["GET", "/api/cache/heartbeat", "cache:read"],
            ["POST", "/api/cache/git.workspace/refresh", undefined],
            ["GET", "/api/job-executions/123", undefined],
            ["GET", "/api/backups/kopia", undefined],
            ["POST", "/api/backups/kopia/run", undefined],
            ["GET", "/api/cron/jobs", undefined],
            ["GET", "/api/files/workspace/secret", undefined],
            ["GET", "/api/jobs", undefined],
            ["POST", "/api/ops/log-rotation/run", undefined],
            ["POST", "/api/pull-requests/123/deploy", undefined],
            ["POST", "/api/restart", undefined],
            ["GET", "/api/sessions", undefined],
            ["GET", "/api/terminal/completions", undefined],
            ["POST", "/api/exec/start", undefined],
            ["GET", "/api/config", undefined],
            ["DELETE", "/api/docker/images/sha256:abc", undefined],
            ["GET", "/api/tasks-archive", undefined],
            ["POST", "/api/tasks/../exec/start", undefined],
            ["POST", "/api/tasks/%2e%2e%2fexec%2fstart", undefined],
            ["GET", "/api/tasks/%31", undefined],
        ];
        for (const [method, pathname, expected] of cases) {
            expect(requiredAutomationScope(request(pathname, method))).toBe(expected);
        }
    });

    it("prefers bearer scopes over legacy loopback and audits allowed or denied writes", async () => {
        const serialized = credentialsJson();
        const writerAuthorization = authorization("mira-writer", WRITER_VALIDATOR);
        const readerAuthorization = authorization("mira-reader", READER_VALIDATOR);
        const invalidWriterAuthorization = authorization("mira-writer", "ff".repeat(32));
        const authenticateAutomation = (automationRequest: Request) =>
            authenticateAutomationRequest(automationRequest, serialized);
        const tasksHandler = jest.fn(
            (handlerRequest: Request, handlerServer: Server<unknown>) =>
                Response.json({
                    isOk: Boolean(handlerRequest.url && handlerServer.requestIP),
                })
        );
        const execHandler = jest.fn(
            (handlerRequest: Request, handlerServer: Server<unknown>) =>
                Response.json({
                    isOk: Boolean(handlerRequest.url && handlerServer.requestIP),
                })
        );
        const agentStatusHandler = jest.fn(
            (handlerRequest: Request, handlerServer: Server<unknown>) =>
                Response.json({
                    isOk: Boolean(handlerRequest.url && handlerServer.requestIP),
                })
        );
        const routes = withRequestPolicy(
            {
                "/api/agents/status": { GET: agentStatusHandler },
                "/api/exec/start": { POST: execHandler },
                "/api/tasks": {
                    GET: tasksHandler,
                    POST: tasksHandler,
                },
            },
            { authenticateAutomation }
        );
        const server = loopbackServer();

        const readResponse = await routes["/api/tasks"].GET(
            request("/api/tasks", "GET", readerAuthorization),
            server
        );
        expect(readResponse.status).toBe(200);

        const writeResponse = await routes["/api/tasks"].POST(
            request("/api/tasks", "POST", writerAuthorization),
            server
        );
        expect(writeResponse.status).toBe(200);
        expect(
            auditRows(writeResponse.headers.get("x-request-id")).map((row) => ({
                action: row.action,
                actorId: row.actor_id,
                actorType: row.actor_type,
                metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
                outcome: row.outcome,
            }))
        ).toEqual([
            {
                action: "http.request",
                actorId: "mira-writer",
                actorType: "automation",
                metadata: {
                    automationScope: "tasks:write",
                    method: "POST",
                },
                outcome: "attempted",
            },
            {
                action: "http.request",
                actorId: "mira-writer",
                actorType: "automation",
                metadata: {
                    automationScope: "tasks:write",
                    method: "POST",
                    status: 200,
                },
                outcome: "accepted",
            },
        ]);

        const agentReconciliation = await routes["/api/agents/status"].GET(
            request("/api/agents/status", "GET", writerAuthorization),
            server
        );
        expect(agentReconciliation.status).toBe(200);
        expect(
            auditRows(agentReconciliation.headers.get("x-request-id")).map((row) => ({
                actorId: row.actor_id,
                actorType: row.actor_type,
                metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
                outcome: row.outcome,
            }))
        ).toEqual([
            {
                actorId: "mira-writer",
                actorType: "automation",
                metadata: {
                    automationScope: "agents:write",
                    method: "GET",
                },
                outcome: "attempted",
            },
            {
                actorId: "mira-writer",
                actorType: "automation",
                metadata: {
                    automationScope: "agents:write",
                    method: "GET",
                    status: 200,
                },
                outcome: "accepted",
            },
        ]);
        const loopbackAgentRead = await routes["/api/agents/status"].GET(
            request("/api/agents/status"),
            server
        );
        expect(loopbackAgentRead.status).toBe(401);
        expect(auditRows(loopbackAgentRead.headers.get("x-request-id"))).toEqual([]);

        const readOnlyWrite = await routes["/api/tasks"].POST(
            request("/api/tasks", "POST", readerAuthorization),
            server
        );
        expect(readOnlyWrite.status).toBe(403);
        await expect(readOnlyWrite.json()).resolves.toEqual({
            error: "Automation credential scope denied",
        });
        expect(auditRows(readOnlyWrite.headers.get("x-request-id"))).toEqual([
            expect.objectContaining({
                actor_id: "mira-reader",
                actor_type: "automation",
                outcome: "denied",
            }),
        ]);

        const privilegedResponse = await routes["/api/exec/start"].POST(
            request("/api/exec/start", "POST", writerAuthorization),
            server
        );
        expect(privilegedResponse.status).toBe(403);
        expect(execHandler).not.toHaveBeenCalled();
        expect(auditRows(privilegedResponse.headers.get("x-request-id"))).toEqual([
            expect.objectContaining({
                actor_id: "mira-writer",
                actor_type: "automation",
                outcome: "denied",
            }),
        ]);

        const invalidBearer = await routes["/api/tasks"].GET(
            request("/api/tasks", "GET", invalidWriterAuthorization),
            server
        );
        expect(invalidBearer.status).toBe(401);
        expect(auditRows(invalidBearer.headers.get("x-request-id"))).toEqual([]);
        expect(tasksHandler).toHaveBeenCalledTimes(2);

        const unrelatedAuthorization = await routes["/api/tasks"].GET(
            request("/api/tasks", "GET", "Basic handled-upstream"),
            server
        );
        expect(unrelatedAuthorization.status).toBe(401);

        const legacyLoopback = await routes["/api/tasks"].GET(
            request("/api/tasks"),
            server
        );
        expect(legacyLoopback.status).toBe(401);
        expect(tasksHandler).toHaveBeenCalledTimes(2);
    });

    it("fails closed when a denied automation audit cannot be stored", async () => {
        const serialized = credentialsJson();
        const handler = jest.fn(() => new Response("must not run"));
        const persistenceError = new Error("audit storage unavailable");
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            const routes = withRequestPolicy(
                { "/api/exec/start": { POST: handler } },
                {
                    authenticateAutomation: (automationRequest) =>
                        authenticateAutomationRequest(automationRequest, serialized),
                    persistAuditEvent: () => {
                        throw persistenceError;
                    },
                }
            );

            const securedPost = routes["/api/exec/start"].POST as unknown as (
                request: Request,
                server: Server<unknown>
            ) => Promise<Response>;
            const response = await securedPost(
                request(
                    "/api/exec/start",
                    "POST",
                    authorization("mira-writer", WRITER_VALIDATOR)
                ),
                loopbackServer()
            );

            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toEqual({
                error: "Audit trail unavailable",
            });
            expect(handler).not.toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining("denied persistence failed"),
                persistenceError
            );
        } finally {
            errorSpy.mockRestore();
        }
    });
});
