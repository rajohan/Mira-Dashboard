import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type {
    GetServiceActionsStatusResult,
    RequestServiceActionInput,
    RequestServiceActionResult,
} from "../../../contracts/serviceActions.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAuthenticationLifecycleService,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
    testSecurityUserId,
    testSessionSelector,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import {
    ServiceActionsServiceError,
    type ServiceActionControlContext,
    type ServiceActionsService,
} from "./service.ts";

const idempotencyKey = "A".repeat(43);
const jobRunId = "018f6f50-6a9e-7b88-8000-000000000001";

const statusResult = Object.freeze({
    actions: [
        { availability: "available" as const, id: "dashboard-restart" as const },
        { availability: "available" as const, id: "openclaw-cleanup" as const },
        { availability: "available" as const, id: "openclaw-restart" as const },
        { availability: "available" as const, id: "openclaw-update" as const },
        { availability: "available" as const, id: "system-cleanup" as const },
        { availability: "available" as const, id: "system-restart" as const },
        { availability: "unavailable" as const, id: "system-update" as const },
        { availability: "available" as const, id: "worker-restart" as const },
    ],
    observedAtMs: 1_800_000_000_000,
}) satisfies GetServiceActionsStatusResult;

const requestInput = Object.freeze({
    actionId: "system-update" as const,
    confirmation: "update-system" as const,
    idempotencyKey,
});

const requestResult = Object.freeze({
    actionId: "system-update" as const,
    jobRunId,
    queued: true as const,
}) satisfies RequestServiceActionResult;

function testService(
    calls: string[],
    contexts: ServiceActionControlContext[] = []
): ServiceActionsService {
    return Object.freeze({
        getStatus: () => {
            calls.push("get-status");
            return Promise.resolve(statusResult);
        },
        request: (
            input: RequestServiceActionInput,
            context: ServiceActionControlContext
        ) => {
            context.reauthorize();
            contexts.push(context);
            calls.push(`request:${input.actionId}:${input.idempotencyKey}`);
            return Promise.resolve(requestResult);
        },
    });
}

async function expectCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<TRPCError> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe(code);
    return failure as TRPCError;
}

describe("Service Actions procedures", () => {
    test("serves bounded status and reauthorizes at the queue handoff", async () => {
        const calls: string[] = [];
        const contexts: ServiceActionControlContext[] = [];
        let authorizationChecks = 0;
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication([
                    "service-actions:read",
                    "service-actions:write",
                ]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        authorizeRecentMfa: () => {
                            authorizationChecks += 1;
                            return "authorized";
                        },
                    }),
                    requestId: "service-actions-request-1",
                    serviceActionsService: testService(calls, contexts),
                }
            )
        ).serviceActions;

        expect(await caller.getStatus({})).toEqual(statusResult);
        expect(await caller.request(requestInput)).toEqual(requestResult);
        expect(calls).toEqual(["get-status", `request:system-update:${idempotencyKey}`]);
        expect(authorizationChecks).toBe(2);
        expect(contexts).toEqual([
            expect.objectContaining({
                actor: {
                    authenticatorId: testSessionSelector,
                    id: testSecurityUserId,
                    kind: "user",
                },
                requestId: "service-actions-request-1",
            }),
        ]);
    });

    test("rejects anonymous, automation, and capability-crossed callers", async () => {
        const calls: string[] = [];
        const serviceActionsService = testService(calls);
        const anonymous = appRouter.createCaller(
            await createTestRequestContext(undefined, createTestApplicationRuntime(), {
                serviceActionsService,
            })
        ).serviceActions;
        await expectCode(() => anonymous.getStatus({}), "UNAUTHORIZED");

        const automation = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication([
                    "service-actions:read",
                    "service-actions:write",
                ]),
                createTestApplicationRuntime(),
                { serviceActionsService }
            )
        ).serviceActions;
        await expectCode(() => automation.getStatus({}), "FORBIDDEN");
        await expectCode(() => automation.request(requestInput), "FORBIDDEN");

        const readOnly = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["service-actions:read"]),
                createTestApplicationRuntime(),
                { serviceActionsService }
            )
        ).serviceActions;
        expect(await readOnly.getStatus({})).toEqual(statusResult);
        await expectCode(() => readOnly.request(requestInput), "FORBIDDEN");

        const writeOnly = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["service-actions:write"]),
                createTestApplicationRuntime(),
                { serviceActionsService }
            )
        ).serviceActions;
        await expectCode(() => writeOnly.getStatus({}), "FORBIDDEN");
        expect(calls).toEqual(["get-status"]);
    });

    test("enforces recent MFA before service dispatch and clears changed sessions", async () => {
        for (const [status, code] of [
            ["mfa-enrollment-required", "FORBIDDEN"],
            ["step-up-required", "FORBIDDEN"],
            ["session-changed", "UNAUTHORIZED"],
        ] as const) {
            const calls: string[] = [];
            const responseHeaders = new Headers();
            const caller = appRouter.createCaller(
                await createTestRequestContext(
                    createTestSessionAuthentication(["service-actions:write"]),
                    createTestApplicationRuntime(),
                    {
                        authenticationLifecycle: createTestAuthenticationLifecycleService(
                            {
                                authorizeRecentMfa: () => status,
                            }
                        ),
                        responseHeaders,
                        serviceActionsService: testService(calls),
                    }
                )
            ).serviceActions;

            await expectCode(() => caller.request(requestInput), code);
            expect(calls).toEqual([]);
            expect(responseHeaders.get("set-cookie") ?? "").toContain(
                status === "session-changed" ? "Max-Age=0" : ""
            );
        }
    });

    test("clears a session that changes at the post-preflight handoff", async () => {
        const calls: string[] = [];
        const responseHeaders = new Headers();
        let authorizationChecks = 0;
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["service-actions:write"]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        authorizeRecentMfa: () =>
                            authorizationChecks++ === 0
                                ? "authorized"
                                : "session-changed",
                    }),
                    responseHeaders,
                    serviceActionsService: testService(calls),
                }
            )
        ).serviceActions;

        await expectCode(() => caller.request(requestInput), "UNAUTHORIZED");
        expect(authorizationChecks).toBe(2);
        expect(calls).toEqual([]);
        expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
    });

    test("maps only fixed conflict, unavailable, audit, and unknown-outcome errors", async () => {
        for (const [reason, code, expectedMessage] of [
            [
                "conflict",
                "CONFLICT",
                "Service action request conflicts with an existing intent",
            ],
            [
                "audit-unavailable",
                "SERVICE_UNAVAILABLE",
                "Service actions are temporarily unavailable",
            ],
            [
                "unavailable",
                "SERVICE_UNAVAILABLE",
                "Service actions are temporarily unavailable",
            ],
            [
                "unknown-outcome",
                "SERVICE_UNAVAILABLE",
                "Service action queue outcome could not be confirmed",
            ],
        ] as const) {
            const caller = appRouter.createCaller(
                await createTestRequestContext(
                    createTestSessionAuthentication(["service-actions:write"]),
                    createTestApplicationRuntime(),
                    {
                        serviceActionsService: Object.freeze({
                            getStatus: () => Promise.resolve(statusResult),
                            request: () =>
                                Promise.reject(
                                    new ServiceActionsServiceError(reason, {
                                        cause: new Error("private host detail"),
                                    })
                                ),
                        }),
                    }
                )
            ).serviceActions;

            const failure = await expectCode(() => caller.request(requestInput), code);
            expect(failure.message).toBe(expectedMessage);
            expect(failure.message).not.toContain("private host detail");
        }

        const statusCaller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["service-actions:read"]),
                createTestApplicationRuntime(),
                {
                    serviceActionsService: Object.freeze({
                        getStatus: () =>
                            Promise.reject(new ServiceActionsServiceError("unavailable")),
                        request: () => Promise.resolve(requestResult),
                    }),
                }
            )
        ).serviceActions;
        await expectCode(() => statusCaller.getStatus({}), "SERVICE_UNAVAILABLE");
    });
});
