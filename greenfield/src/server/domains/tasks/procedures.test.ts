import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import { automationPrincipals } from "../../database/schema/automationPrincipals.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import {
    openFreshMigratedDatabase,
    taskServiceFor,
    taskTestUuid,
} from "./testSupport/taskService.ts";

describe("task procedures", () => {
    test("enforces read and write capabilities before entering the service", async () => {
        for (const testCase of [
            {
                authentication: undefined,
                code: "UNAUTHORIZED",
                operation: "list" as const,
            },
            {
                authentication: createTestSessionAuthentication(["reports:read"]),
                code: "FORBIDDEN",
                operation: "list" as const,
            },
            {
                authentication: createTestSessionAuthentication(["tasks:read"]),
                code: "FORBIDDEN",
                operation: "create" as const,
            },
        ] as const) {
            const context = await createTestRequestContext(testCase.authentication);
            const caller = appRouter.createCaller(context).tasks;
            const failure = await captureFailure(() =>
                testCase.operation === "list"
                    ? caller.list({ limit: 10 })
                    : caller.create({ title: "Forbidden task" })
            );
            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe(testCase.code);
        }
    });

    test("serves validated task outputs to session and automation callers", async () => {
        const database = await openFreshMigratedDatabase();
        database.orm
            .insert(automationPrincipals)
            .values({
                createdAt: new Date(1000),
                id: "test-automation",
                label: "Test automation",
                updatedAt: new Date(1000),
            })
            .run();
        const taskService = taskServiceFor(database);

        try {
            const sessionContext = await createTestRequestContext(
                createTestSessionAuthentication(["tasks:read", "tasks:write"]),
                createTestApplicationRuntime(),
                { taskService }
            );
            const sessionCaller = appRouter.createCaller(sessionContext).tasks;
            const created = await sessionCaller.create({
                labels: ["ops", "security"],
                title: "Review task boundary",
            });
            expect(created).toMatchObject({
                labels: ["ops", "security"],
                status: "todo",
                version: 1,
            });
            expect(await sessionCaller.listLabels({})).toEqual({
                labels: ["ops", "security"],
                truncated: false,
            });

            const automationContext = await createTestRequestContext(
                createTestAutomationAuthentication(["tasks:read", "tasks:write"]),
                createTestApplicationRuntime(),
                { taskService }
            );
            const automationCaller = appRouter.createCaller(automationContext).tasks;
            expect(await automationCaller.list({ limit: 10 })).toMatchObject({
                tasks: [{ id: created.id, title: "Review task boundary" }],
            });
            expect(
                await automationCaller.addUpdate({
                    messageMarkdown: "Automation verified the boundary",
                    taskId: created.id,
                })
            ).toMatchObject({
                author: {
                    id: "test-automation",
                    kind: "automation",
                    label: "Test automation",
                },
                taskId: created.id,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("maps absent resources and stale versions to stable tRPC errors", async () => {
        const database = await openFreshMigratedDatabase();
        const taskService = taskServiceFor(database);

        try {
            const context = await createTestRequestContext(
                createTestAutomationAuthentication(["tasks:read", "tasks:write"]),
                createTestApplicationRuntime(),
                { taskService }
            );
            const caller = appRouter.createCaller(context).tasks;
            const missing = await captureFailure(() =>
                caller.get({ id: taskTestUuid(90_000) })
            );
            expect(missing).toBeInstanceOf(TRPCError);
            expect((missing as TRPCError).code).toBe("NOT_FOUND");

            const created = await caller.create({ title: "Versioned task" });
            await caller.move({
                expectedVersion: created.version,
                id: created.id,
                status: "done",
            });
            const stale = await captureFailure(() =>
                caller.move({
                    expectedVersion: created.version,
                    id: created.id,
                    status: "blocked",
                })
            );
            expect(stale).toBeInstanceOf(TRPCError);
            expect((stale as TRPCError).code).toBe("CONFLICT");
        } finally {
            database.sqlite.close(true);
        }
    });
});
