import { describe, expect, test } from "bun:test";

import { createTestAgentService } from "../domains/agents/testSupport/service.ts";
import { createTestJobService } from "../domains/jobs/testSupport/service.ts";
import {
    createTestMonitoringCatalogService,
    createTestMonitoringService,
} from "../domains/monitoring/testSupport/services.ts";
import { createTestTaskService } from "../domains/tasks/testSupport/service.ts";
import { readAuthenticationHttpCredentials } from "../rawHttp/authenticationCredentials.ts";
import { generateOpaqueToken } from "../shared/opaqueToken.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestAutomationSecurityLifecycleService,
    createTestMfaAccountLifecycleService,
    createTestMfaLoginLifecycleService,
    createTestSecurityAuditLifecycleService,
} from "../test/support/requestContext.ts";
import { createRequestContext } from "./context.ts";

describe("tRPC request context", () => {
    test("validates and freezes the authentication boundary", async () => {
        const pendingLogin = generateOpaqueToken("pending-login");
        const request = new Request("http://localhost/trpc/events.stream", {
            headers: {
                cookie: `__Host-mira_dashboard_pending_login=${pendingLogin.token}`,
                "user-agent": "Context Test Browser",
            },
        });
        const credentials = readAuthenticationHttpCredentials(request);
        let observedCredential: unknown;
        const applicationRuntime = createTestApplicationRuntime();
        const authenticationLifecycle = createTestAuthenticationLifecycleService();
        const automationSecurityLifecycle =
            createTestAutomationSecurityLifecycleService();
        const monitoringCatalogService = createTestMonitoringCatalogService();
        const monitoringService = createTestMonitoringService();
        const jobService = createTestJobService();
        const responseHeaders = new Headers();

        const context = await createRequestContext({
            agentService: createTestAgentService(),
            applicationRuntime,
            authenticationCredential: credentials.authentication,
            authenticationClientSourceId: "client-source-1",
            authenticationLifecycle,
            automationSecurityLifecycle,
            authenticateCredential(candidate) {
                observedCredential = candidate;
                return {
                    authentication: {
                        kind: "authenticated",
                        principal: {
                            authorizationVersion: 1,
                            capabilities: ["reports:read", "notifications:read"],
                            authenticatorId: "a".repeat(32),
                            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                            kind: "session",
                        },
                    },
                    lease: {
                        expiresAtMs: 1_800_000_000_000,
                        revalidate: () => Promise.resolve({ kind: "invalid" }),
                    },
                };
            },
            mfaAccountLifecycle: createTestMfaAccountLifecycleService(),
            mfaLoginLifecycle: createTestMfaLoginLifecycleService(),
            jobService,
            monitoringCatalogService,
            monitoringService,
            pendingLoginCredential: credentials.pendingLogin,
            request,
            requestId: "request-context-1",
            responseHeaders,
            securityAuditLifecycle: createTestSecurityAuditLifecycleService(),
            taskService: createTestTaskService(),
        });

        expect(observedCredential).toEqual({ kind: "anonymous" });
        expect(context.authentication).toEqual({
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: ["notifications:read", "reports:read"],
                authenticatorId: "a".repeat(32),
                id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "session",
            },
        });
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.authentication)).toBe(true);
        expect(Object.isFrozen(context.authenticationLease)).toBe(true);
        expect(context.services).toBe(applicationRuntime.services);
        expect(context.authenticationLifecycle).toBe(authenticationLifecycle);
        expect(context.automationSecurityLifecycle).toBe(automationSecurityLifecycle);
        expect(context.monitoringCatalogService).toBe(monitoringCatalogService);
        expect(context.monitoringService).toBe(monitoringService);
        expect(context.jobService).toBe(jobService);
        expect(context.authenticationClientSourceId).toBe("client-source-1");
        expect(context.pendingLoginCredential).toEqual({
            kind: "present",
            token: {
                prefix: pendingLogin.prefix,
                validatorHash: pendingLogin.validatorHash,
            },
        });
        expect(context.responseHeaders).toBe(responseHeaders);
        expect(context.requestId).toBe("request-context-1");
        expect(context.userAgent).toBe("Context Test Browser");
        expect("dispose" in context.services).toBe(false);
        if (context.authentication.kind === "authenticated") {
            expect(Object.isFrozen(context.authentication.principal)).toBe(true);
            expect(Object.isFrozen(context.authentication.principal.capabilities)).toBe(
                true
            );
        }
    });

    test("omits user-agent metadata when the request header is absent", async () => {
        const request = new Request("http://localhost/trpc/auth.status");
        const credentials = readAuthenticationHttpCredentials(request);
        const context = await createRequestContext({
            agentService: createTestAgentService(),
            applicationRuntime: createTestApplicationRuntime(),
            authenticationCredential: credentials.authentication,
            authenticationClientSourceId: "client-source-without-user-agent",
            authenticationLifecycle: createTestAuthenticationLifecycleService(),
            automationSecurityLifecycle: createTestAutomationSecurityLifecycleService(),
            authenticateCredential: () => ({ authentication: { kind: "anonymous" } }),
            mfaAccountLifecycle: createTestMfaAccountLifecycleService(),
            mfaLoginLifecycle: createTestMfaLoginLifecycleService(),
            jobService: createTestJobService(),
            monitoringCatalogService: createTestMonitoringCatalogService(),
            monitoringService: createTestMonitoringService(),
            pendingLoginCredential: credentials.pendingLogin,
            request,
            requestId: "request-context-2",
            responseHeaders: new Headers(),
            securityAuditLifecycle: createTestSecurityAuditLifecycleService(),
            taskService: createTestTaskService(),
        });

        expect(context.userAgent).toBeUndefined();
        expect(context.pendingLoginCredential).toEqual({ kind: "absent" });
    });

    test("rejects malformed authentication service output", async () => {
        let failure: unknown;
        try {
            const request = new Request("http://localhost/trpc/events.stream");
            const credentials = readAuthenticationHttpCredentials(request);
            await createRequestContext({
                agentService: createTestAgentService(),
                applicationRuntime: createTestApplicationRuntime(),
                authenticationCredential: credentials.authentication,
                authenticationClientSourceId: "client-source-2",
                authenticationLifecycle: createTestAuthenticationLifecycleService(),
                automationSecurityLifecycle:
                    createTestAutomationSecurityLifecycleService(),
                authenticateCredential: () => ({
                    authentication: {
                        kind: "authenticated",
                        principal: {
                            authorizationVersion: 1,
                            capabilities: ["unknown:admin"],
                            authenticatorId: "a".repeat(32),
                            id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                            kind: "session",
                        },
                    },
                }),
                mfaAccountLifecycle: createTestMfaAccountLifecycleService(),
                mfaLoginLifecycle: createTestMfaLoginLifecycleService(),
                jobService: createTestJobService(),
                monitoringCatalogService: createTestMonitoringCatalogService(),
                monitoringService: createTestMonitoringService(),
                pendingLoginCredential: credentials.pendingLogin,
                request,
                requestId: "request-context-3",
                responseHeaders: new Headers(),
                securityAuditLifecycle: createTestSecurityAuditLifecycleService(),
                taskService: createTestTaskService(),
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
    });
});
