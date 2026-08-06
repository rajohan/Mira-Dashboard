import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import * as v from "valibot";

import { procedureContracts } from "../../contracts/contractRegistry.ts";
import type { ProcedureContract } from "../../contracts/registry.ts";
import {
    DatabaseRuntimeWriteAdmissionTimeoutError,
    DatabaseRuntimeWriteContentionError,
} from "../database/runtime/databaseErrors.ts";
import { AuthenticationWorkSettlementError } from "../domains/security/authenticationWorkGate.ts";
import { captureFailure } from "../test/support/promise.ts";
import { createTestRequestContext } from "../test/support/requestContext.ts";
import {
    applyProcedureExpectedErrorPolicy,
    assertProcedureExpectedErrorPolicy,
    procedureExpectedErrorPolicy,
    type ProcedureExpectedErrorPolicy,
} from "./procedureErrorPolicy.ts";
import { publicProcedure, router } from "./trpc.ts";

const contractFixture = [
    { errors: ["FORBIDDEN"], name: "example.read" },
] as const satisfies readonly Pick<ProcedureContract, "errors" | "name">[];
const invalidPolicyFixtures: {
    name: string;
    policy: ProcedureExpectedErrorPolicy;
}[] = [
    {
        name: "missing route",
        policy: {},
    },
    {
        name: "extra route",
        policy: {
            "example.read": ["FORBIDDEN"],
            "example.write": [],
        },
    },
    {
        name: "error-code drift",
        policy: { "example.read": ["UNAUTHORIZED"] },
    },
];

describe("procedure expected-error policy", () => {
    test("matches every registered procedure contract exactly", () => {
        expect(() =>
            assertProcedureExpectedErrorPolicy(
                procedureContracts,
                procedureExpectedErrorPolicy
            )
        ).not.toThrow();
    });

    test("deeply freezes the exported runtime allowlist", () => {
        expect(Object.isFrozen(procedureExpectedErrorPolicy)).toBe(true);
        for (const errors of Object.values(procedureExpectedErrorPolicy)) {
            expect(Object.isFrozen(errors)).toBe(true);
        }

        const logoutErrors = procedureExpectedErrorPolicy["auth.logout"];
        expect(() =>
            Reflect.apply(Array.prototype.push, logoutErrors, ["UNAUTHORIZED"])
        ).toThrow();
        expect(logoutErrors).toEqual(["SERVICE_UNAVAILABLE"]);
    });

    test.each(invalidPolicyFixtures)("rejects $name", ({ policy }) => {
        expect(() =>
            assertProcedureExpectedErrorPolicy(contractFixture, policy)
        ).toThrow();
    });

    test("passes declared errors and internalizes undeclared route errors", async () => {
        const sentinel = "undeclared route detail";
        const testRouter = router({
            auth: router({
                bootstrap: publicProcedure.query(() => {
                    throw new TRPCError({
                        code: "UNAUTHORIZED",
                        message: "Gateway credential is invalid",
                    });
                }),
                status: publicProcedure.query(() => {
                    throw new TRPCError({
                        code: "FORBIDDEN",
                        message: sentinel,
                    });
                }),
            }),
        });
        const caller = testRouter.createCaller(await createTestRequestContext());

        const declared = await captureFailure(() => caller.auth.bootstrap());
        expect(declared).toBeInstanceOf(TRPCError);
        expect((declared as TRPCError).code).toBe("UNAUTHORIZED");

        const undeclared = await captureFailure(() => caller.auth.status());
        expect(undeclared).toBeInstanceOf(TRPCError);
        expect((undeclared as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
        expect((undeclared as TRPCError).message).not.toContain(sentinel);
    });

    test.each([
        {
            error: new DatabaseRuntimeWriteAdmissionTimeoutError({
                message: "private timeout detail",
                timeoutMs: 5000,
            }),
            name: "admission timeout",
        },
        {
            error: new DatabaseRuntimeWriteContentionError({
                message: "private contention detail",
            }),
            name: "post-admission contention",
        },
    ])("maps direct and settled $name failures only for declared routes", ({ error }) => {
        for (const cause of [
            error,
            new AuthenticationWorkSettlementError({
                cause: error,
                operation: "webauthn",
            }),
        ]) {
            const internal = new TRPCError({
                cause,
                code: "INTERNAL_SERVER_ERROR",
                message: "private tRPC detail",
            });
            const declared = applyProcedureExpectedErrorPolicy("auth.logout", internal);
            expect(declared).toMatchObject({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Database write capacity is temporarily unavailable",
            });

            const undeclared = applyProcedureExpectedErrorPolicy("auth.status", internal);
            expect(undeclared.code).toBe("INTERNAL_SERVER_ERROR");
            expect(undeclared.message).not.toContain(error.message);
        }
    });

    test("internalizes expected-looking errors from unregistered procedure paths", async () => {
        const testRouter = router({
            unregistered: publicProcedure.query(() => {
                throw new TRPCError({
                    code: "FORBIDDEN",
                    message: "Unregistered route failure",
                });
            }),
        });
        const caller = testRouter.createCaller(await createTestRequestContext());
        const failure = await captureFailure(() => caller.unregistered());

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    });

    test("treats inherited object keys as unregistered procedure paths", () => {
        for (const path of ["constructor", "toString", "valueOf"] as const) {
            const result = applyProcedureExpectedErrorPolicy(
                path,
                new TRPCError({ code: "FORBIDDEN" })
            );
            expect(result.code).toBe("INTERNAL_SERVER_ERROR");
        }
    });

    test("keeps framework input validation implicit", async () => {
        const statusInputSchema = v.strictObject({});
        const statusProcedure = publicProcedure
            .input(statusInputSchema)
            .query(() => ({ isOk: true as const }));
        const testRouter = router({
            auth: router({
                status: statusProcedure,
            }),
        });
        const caller = testRouter.createCaller(await createTestRequestContext());
        const failure = await captureFailure(() =>
            caller.auth.status({ unexpected: true })
        );

        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("BAD_REQUEST");
    });

    test("enforces the policy while a subscription is iterated", async () => {
        const testRouter = router({
            system: router({
                runtimeIdentity: publicProcedure.subscription(async function* () {
                    await Promise.resolve();
                    yield "started";
                    throw new TRPCError({
                        code: "FORBIDDEN",
                        message: "Deferred undeclared failure",
                    });
                }),
            }),
        });
        const caller = testRouter.createCaller(await createTestRequestContext());
        const stream = await caller.system.runtimeIdentity();
        const iterator = stream[Symbol.asyncIterator]();

        expect(await iterator.next()).toEqual({ done: false, value: "started" });
        const failure = await captureFailure(() => iterator.next());
        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("INTERNAL_SERVER_ERROR");
    });

    test("preserves declared errors raised during subscription iteration", async () => {
        const testRouter = router({
            events: router({
                stream: publicProcedure.subscription(async function* () {
                    await Promise.resolve();
                    yield "started";
                    throw new TRPCError({ code: "TOO_MANY_REQUESTS" });
                }),
            }),
        });
        const caller = testRouter.createCaller(await createTestRequestContext());
        const stream = await caller.events.stream();
        const iterator = stream[Symbol.asyncIterator]();

        expect(await iterator.next()).toEqual({ done: false, value: "started" });
        const failure = await captureFailure(() => iterator.next());
        expect(failure).toBeInstanceOf(TRPCError);
        expect((failure as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    });
});
