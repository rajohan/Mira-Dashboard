import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import { captureFailure } from "../test/support/promise.ts";
import {
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../test/support/requestContext.ts";
import { capabilityProcedure, router } from "./trpc.ts";

const capabilityTestRouter = router({
    events: router({
        stream: capabilityProcedure("notifications:read").query(
            ({ ctx }) => ctx.principal.kind
        ),
    }),
});

describe("tRPC capability procedure", () => {
    test.each(["automation", "session"] as const)(
        "allows the %s principal with the exact capability",
        async (principalKind) => {
            const authentication =
                principalKind === "automation"
                    ? createTestAutomationAuthentication(["notifications:read"])
                    : createTestSessionAuthentication([
                          "notifications:read",
                          "reports:read",
                      ]);
            const context = await createTestRequestContext(authentication);
            const resolvedPrincipalKind = await capabilityTestRouter
                .createCaller(context)
                .events.stream();

            expect(resolvedPrincipalKind).toBe(principalKind);
        }
    );

    test.each(["automation", "session"] as const)(
        "denies the %s principal whose grants omit the exact capability",
        async (principalKind) => {
            const authentication =
                principalKind === "automation"
                    ? createTestAutomationAuthentication(["reports:read"])
                    : createTestSessionAuthentication([]);
            const context = await createTestRequestContext(authentication);
            const failure = await captureFailure(() =>
                capabilityTestRouter.createCaller(context).events.stream()
            );

            expect(failure).toBeInstanceOf(TRPCError);
            expect((failure as TRPCError).code).toBe("FORBIDDEN");
        }
    );

    test("rejects an unauthenticated caller before capability evaluation", async () => {
        const context = await createTestRequestContext();
        const failure = await captureFailure(() =>
            capabilityTestRouter.createCaller(context).events.stream()
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("UNAUTHORIZED");
    });
});
