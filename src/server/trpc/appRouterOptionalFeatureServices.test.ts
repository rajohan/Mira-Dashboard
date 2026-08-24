import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import { captureFailure } from "../test/support/promise.ts";
import {
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../test/support/requestContext.ts";
import { appRouter } from "./appRouter.ts";

describe("optional feature service routes", () => {
    test("maps unconfigured files, logs, and terminal ports to service unavailable", async () => {
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["files:read", "logs:read", "terminal:read"])
        );
        const caller = appRouter.createCaller(context);
        const operations = [
            {
                message: "Workspace files are temporarily unavailable",
                run: () => caller.files.listRoots({}),
            },
            {
                message: "Logs are temporarily unavailable",
                run: () => caller.logs.listSources({}),
            },
            {
                message: "Interactive terminal is temporarily unavailable",
                run: () => caller.terminal.getRuntime({}),
            },
        ];

        for (const operation of operations) {
            const failure = await captureFailure(operation.run);
            expect(failure).toBeInstanceOf(TRPCError);
            expect(failure).toMatchObject({
                code: "SERVICE_UNAVAILABLE",
                message: operation.message,
            });
        }
    });
});
