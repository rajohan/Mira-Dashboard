import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSecurityAuditLifecycleService,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";

describe("security audit procedures", () => {
    test("rejects anonymous and automation callers", async () => {
        for (const testCase of [
            { authentication: undefined, code: "UNAUTHORIZED" },
            {
                authentication: createTestAutomationAuthentication(["reports:read"]),
                code: "FORBIDDEN",
            },
        ] as const) {
            const context = await createTestRequestContext(testCase.authentication);
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).securityAudit.listEvents({ limit: 20 })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
        }
    });

    test("returns validated redacted history for a browser session", async () => {
        const event = {
            action: "auth.logout",
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "user" as const,
            },
            id: "019fc968-1a9b-7771-8f1b-d5b863b0e7b4",
            metadata: {},
            occurredAtMs: 1_800_000_000_000,
            outcome: "succeeded" as const,
            target: { id: "a".repeat(32), type: "auth_session" },
        };
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                securityAuditLifecycle: createTestSecurityAuditLifecycleService({
                    listEvents: () => ({
                        result: { events: [event] },
                        status: "listed",
                    }),
                }),
            }
        );

        expect(
            await appRouter.createCaller(context).securityAudit.listEvents({
                limit: 20,
            })
        ).toEqual({ events: [event] });
    });

    test("clears the cookie when session state changes", async () => {
        const responseHeaders = new Headers();
        const context = await createTestRequestContext(
            createTestSessionAuthentication([]),
            createTestApplicationRuntime(),
            {
                responseHeaders,
                securityAuditLifecycle: createTestSecurityAuditLifecycleService(),
            }
        );

        const failure = await captureFailure(() =>
            appRouter.createCaller(context).securityAudit.listEvents({ limit: 20 })
        );
        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
        expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
    });
});
