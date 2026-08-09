import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import {
    GatewaySessionProviderAbortError,
    type GatewaySessionProviderRequest,
    type GatewaySessionsProvider,
} from "../gatewaySessions/provider.ts";
import { createGatewaySessionsService } from "../gatewaySessions/service.ts";
import {
    agentServiceFor,
    openFreshMigratedDatabase,
} from "./testSupport/agentService.ts";

describe("agent procedures", () => {
    test("enforces exact read and write capabilities", async () => {
        for (const testCase of [
            { authentication: undefined, code: "UNAUTHORIZED", operation: "read" },
            {
                authentication: createTestSessionAuthentication(["reports:read"]),
                code: "FORBIDDEN",
                operation: "read",
            },
            {
                authentication: createTestSessionAuthentication(["agents:read"]),
                code: "FORBIDDEN",
                operation: "write",
            },
            {
                authentication: createTestSessionAuthentication(["agents:write"]),
                code: "FORBIDDEN",
                operation: "write",
            },
        ] as const) {
            const caller = appRouter.createCaller(
                await createTestRequestContext(testCase.authentication)
            ).agents;
            const failure = await captureFailure(() =>
                testCase.operation === "read"
                    ? caller.listStatuses({})
                    : caller.updateMetadata({ agentId: "main", currentTask: null })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
        }
    });

    test("serves session reads and automation current-task writes", async () => {
        const database = await openFreshMigratedDatabase();
        const agentService = agentServiceFor(database);
        try {
            const automationContext = await createTestRequestContext(
                createTestAutomationAuthentication(["agents:read", "agents:write"]),
                createTestApplicationRuntime(),
                { agentService }
            );
            const automationCaller = appRouter.createCaller(automationContext).agents;
            expect(
                await automationCaller.updateMetadata({
                    agentId: "main",
                    currentTask: "Implement agent procedures",
                })
            ).toMatchObject({ state: "working" });

            const sessionContext = await createTestRequestContext(
                createTestSessionAuthentication(["agents:read"]),
                createTestApplicationRuntime(),
                { agentService }
            );
            const sessionCaller = appRouter.createCaller(sessionContext).agents;
            const configuration = await sessionCaller.getConfiguration({});
            expect(configuration.agents.map(({ id }) => id)).toEqual([
                "coder",
                "communicator",
                "main",
                "monitor",
                "researcher",
            ]);
            expect(await sessionCaller.getStatus({ id: "main" })).toMatchObject({
                currentTask: "Implement agent procedures",
                state: "working",
            });
            expect(
                await sessionCaller.listTaskHistory({ agentId: "main", limit: 10 })
            ).toMatchObject({ runs: [{ status: "active" }] });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("maps unknown configured-agent lookups to a stable not-found error", async () => {
        const database = await openFreshMigratedDatabase();
        try {
            const context = await createTestRequestContext(
                createTestAutomationAuthentication(["agents:read"]),
                createTestApplicationRuntime(),
                { agentService: agentServiceFor(database) }
            );
            const failure = await captureFailure(() =>
                appRouter.createCaller(context).agents.getStatus({ id: "unknown" })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe("NOT_FOUND");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("propagates resolver cancellation through both Gateway availability reads", async () => {
        const database = await openFreshMigratedDatabase();
        let started = Promise.withResolvers<AbortSignal | undefined>();
        const provider: GatewaySessionsProvider = Object.freeze({
            compactSession: () => Promise.reject(new Error("Unexpected compact")),
            deleteSessionTranscript: () => Promise.reject(new Error("Unexpected delete")),
            listCurrentSessions: (request: GatewaySessionProviderRequest) => {
                const { signal } = request;
                started.resolve(signal);
                return new Promise<never>((_resolve, reject) => {
                    const rejectAborted = () =>
                        reject(new GatewaySessionProviderAbortError());
                    if (signal?.aborted === true) {
                        rejectAborted();
                        return;
                    }
                    signal?.addEventListener("abort", rejectAborted, { once: true });
                });
            },
            resetSession: () => Promise.reject(new Error("Unexpected reset")),
        });
        const agentService = agentServiceFor(database, {
            gatewaySessionsService: createGatewaySessionsService({ provider }),
        });

        try {
            for (const operation of ["getStatus", "listStatuses"] as const) {
                started = Promise.withResolvers<AbortSignal | undefined>();
                const controller = new AbortController();
                const context = await createTestRequestContext(
                    createTestSessionAuthentication(["agents:read"]),
                    createTestApplicationRuntime(),
                    { agentService }
                );
                const caller = appRouter.createCaller(context, {
                    signal: controller.signal,
                }).agents;
                const pending =
                    operation === "getStatus"
                        ? caller.getStatus({ id: "main" })
                        : caller.listStatuses({});
                expect(await started.promise).toBe(controller.signal);
                controller.abort();
                expect(await captureFailure(() => pending)).toBeInstanceOf(Error);
            }
        } finally {
            database.sqlite.close(true);
        }
    });
});
