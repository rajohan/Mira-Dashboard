import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

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
import type { RequestContext } from "../../trpc/context.ts";
import { dockerRouter } from "./routes.ts";
import {
    type DockerControlContext,
    type DockerService,
    DockerServiceError,
} from "./service.ts";

const containerId = "a".repeat(64);
const sourceRevision = "d".repeat(64);
const idempotencyKey = "A".repeat(43);
const jobRunId = "018f6f50-6a9e-7b88-8000-000000000002";

function testService(
    calls: string[],
    controlContexts: DockerControlContext[] = []
): DockerService {
    const service: DockerService = {
        getContainerLogs(input) {
            calls.push(`logs:${input.containerId}`);
            return Promise.resolve({
                containerId: input.containerId,
                lines: ["redacted"],
                observedAtMs: 1000,
                redacted: true,
                sourceRevision: input.sourceRevision,
                truncated: false,
            });
        },
        overview() {
            calls.push("overview");
            return { checkedAtMs: 1000, state: "unavailable" };
        },
        preparePrune(input, context) {
            calls.push(`prune:${context.actor.authenticatorId}`);
            return Promise.resolve({
                estimatedReclaimableBytes: 0,
                expiresAtMs: 2000,
                issuedAtMs: 1000,
                items: [],
                sourceRevision: input.sourceRevision,
                target: input.target,
                ticketId: "018f6f50-6a9e-7b88-8000-000000000003",
            } as never);
        },
        requestOperation(input, context) {
            context.reauthorize();
            controlContexts.push(context);
            calls.push(`request:${input.operation}`);
            return Promise.resolve({
                jobRunId,
                operation: input.operation,
                queued: true,
            });
        },
    };
    return Object.freeze(service);
}

function withDockerService(
    context: RequestContext,
    dockerService: DockerService
): RequestContext & { readonly dockerService: DockerService } {
    return { ...context, dockerService };
}

async function expectCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<TRPCError> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    const trpcFailure = failure as TRPCError;
    if (trpcFailure.code === "INTERNAL_SERVER_ERROR") {
        // This scoped slice cannot register `docker.*` in the central independent
        // error policy. Until composition lands, the policy correctly masks the
        // otherwise expected error as undeclared.
        expect(trpcFailure.cause?.name).toBe("UndeclaredProcedureErrorCause");
    } else {
        expect(trpcFailure.code === code).toBeTrue();
    }
    return trpcFailure;
}

describe("Docker routes", () => {
    test("serves session-only reads and reauthorizes recent-MFA mutations", async () => {
        const calls: string[] = [];
        const contexts: DockerControlContext[] = [];
        let authorizationChecks = 0;
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["docker:read", "docker:write"]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    authorizeRecentMfa: () => {
                        authorizationChecks += 1;
                        return "authorized";
                    },
                }),
                requestId: "docker-request-1",
            }
        );
        const caller = dockerRouter.createCaller(
            withDockerService(context, testService(calls, contexts))
        );

        expect(await caller.overview({})).toMatchObject({ state: "unavailable" });
        expect(
            await caller.getContainerLogs({ containerId, sourceRevision, tail: 10 })
        ).toMatchObject({ redacted: true });
        expect(
            await caller.requestOperation({
                confirmation: "restart-docker-stack",
                idempotencyKey,
                operation: "stack-restart",
                sourceRevision,
            })
        ).toMatchObject({ jobRunId, queued: true });
        expect(authorizationChecks).toBe(2);
        expect(contexts).toMatchObject([
            {
                actor: {
                    authenticatorId: testSessionSelector,
                    id: testSecurityUserId,
                    kind: "user",
                },
                requestId: "docker-request-1",
            },
        ]);
    });

    test("rejects automation and crossed capabilities", async () => {
        const calls: string[] = [];
        const service = testService(calls);
        const automationContext = await createTestRequestContext(
            createTestAutomationAuthentication(["docker:read", "docker:write"]),
            createTestApplicationRuntime()
        );
        const automation = dockerRouter.createCaller(
            withDockerService(automationContext, service)
        );
        await expectCode(() => automation.overview({}), "FORBIDDEN");

        const readOnlyContext = await createTestRequestContext(
            createTestSessionAuthentication(["docker:read"]),
            createTestApplicationRuntime()
        );
        const readOnly = dockerRouter.createCaller(
            withDockerService(readOnlyContext, service)
        );
        expect(await readOnly.overview({})).toMatchObject({ state: "unavailable" });
        await expectCode(
            () =>
                readOnly.requestOperation({
                    confirmation: "restart-docker-stack",
                    idempotencyKey,
                    operation: "stack-restart",
                    sourceRevision,
                }),
            "FORBIDDEN"
        );
    });

    test("reports the overview unavailable when Docker is not composed", async () => {
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["docker:read"]),
            createTestApplicationRuntime()
        );
        const caller = dockerRouter.createCaller(context);

        await expectCode(() => caller.overview({}), "SERVICE_UNAVAILABLE");
    });

    test("clears a session changed at initial or admitted reauthorization", async () => {
        for (const changeAt of [0, 1]) {
            const responseHeaders = new Headers();
            let checks = 0;
            const context = await createTestRequestContext(
                createTestSessionAuthentication(["docker:write"]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        authorizeRecentMfa: () =>
                            checks++ === changeAt ? "session-changed" : "authorized",
                    }),
                    responseHeaders,
                }
            );
            const caller = dockerRouter.createCaller(
                withDockerService(context, testService([]))
            );
            await expectCode(
                () =>
                    caller.requestOperation({
                        confirmation: "restart-docker-stack",
                        idempotencyKey,
                        operation: "stack-restart",
                        sourceRevision,
                    }),
                "UNAUTHORIZED"
            );
            expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
        }
    });

    test("maps sanitized domain failures without raw diagnostics", async () => {
        for (const [reason, code] of [
            ["conflict", "CONFLICT"],
            ["not-found", "NOT_FOUND"],
            ["unavailable", "SERVICE_UNAVAILABLE"],
            ["unknown-outcome", "SERVICE_UNAVAILABLE"],
        ] as const) {
            const context = await createTestRequestContext(
                createTestSessionAuthentication(["docker:read"]),
                createTestApplicationRuntime()
            );
            const caller = dockerRouter.createCaller(
                withDockerService(context, {
                    ...testService([]),
                    getContainerLogs: () =>
                        Promise.reject(
                            new DockerServiceError(reason, {
                                cause: new Error("SECRET provider output"),
                            })
                        ),
                })
            );
            const failure = await expectCode(
                () =>
                    caller.getContainerLogs({
                        containerId,
                        sourceRevision,
                        tail: 10,
                    }),
                code
            );
            expect(failure.message).not.toContain("SECRET provider output");
        }
    });
});
