import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { contractAuthenticationErrorReasons } from "../../../contracts/registry.ts";
import { DatabaseRuntimeWriteAdmissionTimeoutError } from "../../database/runtime/databaseErrors.ts";
import { AuthenticationWorkSettlementError } from "../../domains/security/authenticationWorkGate.ts";
import { authenticationPolicyError, publicProcedure, router } from "../../trpc/trpc.ts";
import { createTestRequestContext } from "../support/requestContext.ts";

const sentinel = "secret /home/ubuntu/private-stack-path";

type ErrorProcedure =
    | (typeof contractAuthenticationErrorReasons)[number]
    | "database-write-unavailable"
    | "expected"
    | "forged-policy-cause"
    | "tampered-policy-cause"
    | "unexpected";

const errorProcedurePaths = {
    "database-write-unavailable": "auth.logout",
    expected: "events.stream",
    "forged-policy-cause": "accountSecurity.summary",
    mfa_enrollment_required: "accountSecurity.stepUpRecovery",
    step_up_required: "auth.changePassword",
    "tampered-policy-cause": "auth.revokeSession",
    unexpected: "system.runtimeIdentity",
} as const satisfies Readonly<Record<ErrorProcedure, string>>;

async function queryWireBody(procedure: ErrorProcedure): Promise<{
    response: Response;
    text: string;
}> {
    const errorRouter = router({
        accountSecurity: router({
            stepUpRecovery: publicProcedure.query(() => {
                throw authenticationPolicyError(
                    "mfa_enrollment_required",
                    "Multi-factor authentication enrollment is required"
                );
            }),
            summary: publicProcedure.query(() => {
                throw new TRPCError({
                    cause: Object.assign(new Error(sentinel), {
                        reason: "step_up_required",
                    }),
                    code: "FORBIDDEN",
                    message: "Safe client error",
                });
            }),
        }),
        auth: router({
            changePassword: publicProcedure.query(() => {
                throw authenticationPolicyError(
                    "step_up_required",
                    "Recent authentication is required"
                );
            }),
            revokeSession: publicProcedure.query(() => {
                const error = authenticationPolicyError(
                    "step_up_required",
                    "Recent authentication is required"
                );
                const { cause } = error;
                if (cause === undefined) {
                    throw new Error("Authentication policy cause is missing");
                }
                Object.assign(cause, {
                    message: sentinel,
                    reason: "unknown_policy_reason",
                });
                throw error;
            }),
            logout: publicProcedure.query(() => {
                throw new AuthenticationWorkSettlementError({
                    cause: new DatabaseRuntimeWriteAdmissionTimeoutError({
                        message: sentinel,
                        timeoutMs: 5000,
                    }),
                    operation: "webauthn",
                });
            }),
        }),
        events: router({
            stream: publicProcedure.query(() => {
                throw new TRPCError({
                    code: "BAD_REQUEST",
                    message: "Safe client error",
                });
            }),
        }),
        system: router({
            runtimeIdentity: publicProcedure.query(() => {
                throw Object.assign(new Error(sentinel), {
                    reason: "step_up_required",
                });
            }),
        }),
    });
    const response = await fetchRequestHandler({
        createContext: () => createTestRequestContext(),
        endpoint: "/trpc",
        req: new Request(`http://localhost/trpc/${errorProcedurePaths[procedure]}`),
        router: errorRouter,
    });
    return { response, text: await response.text() };
}

describe("tRPC error transport", () => {
    test("redacts unknown internal errors from the wire shape", async () => {
        const { response, text } = await queryWireBody("unexpected");

        expect(response.status).toBe(500);
        expect(text).toContain("Internal server error");
        expect(text).not.toContain("secret /home/ubuntu/private-stack-path");
        expect(text).not.toContain('"reason"');
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("preserves explicitly safe expected error messages without stack or path", async () => {
        const { response, text } = await queryWireBody("expected");

        expect(response.status).toBe(400);
        expect(text).toContain("Safe client error");
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("maps durable database-write exhaustion to one redacted 503", async () => {
        const { response, text } = await queryWireBody("database-write-unavailable");

        expect(response.status).toBe(503);
        expect(text).toContain("Database write capacity is temporarily unavailable");
        expect(text).not.toContain(sentinel);
        expect(text).not.toContain("DatabaseRuntimeWriteAdmissionTimeoutError");
        expect(text).not.toContain('"cause"');
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    for (const reason of contractAuthenticationErrorReasons) {
        test(`exposes the allowlisted ${reason} policy reason`, async () => {
            const { response, text } = await queryWireBody(reason);

            expect(response.status).toBe(403);
            expect(text).toContain(`"reason":"${reason}"`);
            expect(text).not.toContain('"stack"');
            expect(text).not.toContain('"path"');
        });
    }

    test("does not trust an arbitrary cause with an allowlisted-looking reason", async () => {
        const { response, text } = await queryWireBody("forged-policy-cause");

        expect(response.status).toBe(403);
        expect(text).toContain("Safe client error");
        expect(text).not.toContain(sentinel);
        expect(text).not.toContain('"reason"');
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });

    test("does not expose a tampered internal policy cause", async () => {
        const { response, text } = await queryWireBody("tampered-policy-cause");

        expect(response.status).toBe(403);
        expect(text).toContain("Recent authentication is required");
        expect(text).not.toContain(sentinel);
        expect(text).not.toContain('"reason"');
        expect(text).not.toContain('"stack"');
        expect(text).not.toContain('"path"');
    });
});
