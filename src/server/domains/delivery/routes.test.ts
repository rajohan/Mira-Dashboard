import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type {
    DeliveryRequestOperationInput,
    DeliveryRequestOperationResult,
} from "../../../contracts/delivery.ts";
import { publishedReleaseAuthority } from "../../../testSupport/publishedReleaseAuthority.ts";
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
import type { RequestContext } from "../../trpc/context.ts";
import {
    type DeliveryControlContext,
    type DeliveryService,
    DeliveryServiceError,
} from "./service.ts";

const headSha = "a".repeat(40);
const secondHeadSha = "b".repeat(40);
const sourceRevision = "c".repeat(64);
const resourceRevision = "d".repeat(64);
const releaseId = "e".repeat(40);
const runtimeRevision = "f".repeat(40);
const idempotencyKey = "A".repeat(43);
const jobRunId = "018f6f50-6a9e-7b88-8000-000000000020";
const snapshotTransitionId = "018f6f50-6a9e-7b88-8000-000000000021";

const approvePullRequestInput = Object.freeze({
    checkoutRevision: resourceRevision,
    confirmation: "merge-delivery-pull-request" as const,
    deploy: false as const,
    expectedHeads: [{ headSha, number: 42 }],
    idempotencyKey,
    mergeStack: false,
    number: 42,
    operation: "merge-pull-request" as const,
    sourceRevision,
});
const approveReviewInput = Object.freeze({
    confirmation: "approve-delivery-review" as const,
    expectedHeadSha: headSha,
    idempotencyKey,
    number: 42,
    operation: "approve-review" as const,
    reviewerRevision: resourceRevision,
    sourceRevision,
});
const createPullRequestStackInput = Object.freeze({
    confirmation: "create-delivery-stack" as const,
    expectedHeads: [
        { headSha: secondHeadSha, number: 41 },
        { headSha, number: 42 },
    ],
    idempotencyKey,
    operation: "create-pull-request-stack" as const,
    sourceRevision,
});
const deployInput = Object.freeze({
    activationRevision: resourceRevision,
    checkoutRevision: resourceRevision,
    confirmation: "deploy-delivery-main" as const,
    expectedMainHeadSha: headSha,
    idempotencyKey,
    operation: "deploy" as const,
    release: publishedReleaseAuthority(headSha, "v1.2.3", runtimeRevision),
    sourceRevision,
});
const rejectPullRequestInput = Object.freeze({
    confirmation: "reject-delivery-pull-request" as const,
    expectedHeadSha: headSha,
    idempotencyKey,
    number: 42,
    operation: "reject-pull-request" as const,
    sourceRevision,
});
const rollbackReleaseInput = Object.freeze({
    activationRevision: resourceRevision,
    confirmation: "rollback-delivery-release" as const,
    idempotencyKey,
    operation: "rollback-release" as const,
    sourceRevision,
    target: {
        databaseSnapshotTransitionId: snapshotTransitionId,
        releaseId,
        runtimeRevision,
    },
});
const startPreviewInput = Object.freeze({
    confirmation: "start-delivery-preview" as const,
    expectedHeads: [{ headSha, number: 42 }],
    idempotencyKey,
    number: 42,
    operation: "start-preview" as const,
    previewRevision: resourceRevision,
    sourceRevision,
});
const stopPreviewInput = Object.freeze({
    confirmation: "stop-delivery-preview" as const,
    idempotencyKey,
    number: 42,
    operation: "stop-preview" as const,
    previewRevision: resourceRevision,
    sourceRevision,
});
const updateBranchInput = Object.freeze({
    confirmation: "update-delivery-pull-request-branch" as const,
    expectedHeadSha: headSha,
    idempotencyKey,
    number: 42,
    operation: "update-branch" as const,
    sourceRevision,
});

function testService(
    calls: string[],
    controlContexts: DeliveryControlContext[] = [],
    failure?: DeliveryServiceError
): DeliveryService {
    function read(method: string) {
        calls.push(method);
        if (failure !== undefined) throw failure;
        return { checkedAtMs: 1000, state: "unavailable" as const };
    }

    function request(
        method: string,
        input: DeliveryRequestOperationInput,
        context: DeliveryControlContext
    ): Promise<DeliveryRequestOperationResult> {
        calls.push(`${method}:${input.operation}`);
        if (failure !== undefined) return Promise.reject(failure);
        context.reauthorize();
        controlContexts.push(context);
        return Promise.resolve({
            jobRunId,
            operation: input.operation,
            queued: true,
        });
    }

    const service: DeliveryService = {
        approvePullRequest: (input, context) =>
            request("approve-pull-request", input, context),
        approveReview: (input, context) => request("approve-review", input, context),
        createPullRequestStack: (input, context) =>
            request("create-pull-request-stack", input, context),
        deploy: (input, context) => request("deploy", input, context),
        getPreview: () => read("get-preview"),
        getProductionCheckout: () => read("get-production-checkout"),
        getReleases: () => read("get-releases"),
        listDeployments: () => read("list-deployments"),
        listPullRequests: () => read("list-pull-requests"),
        rejectPullRequest: (input, context) =>
            request("reject-pull-request", input, context),
        requestOperation: (input, context) =>
            request("request-operation", input, context),
        rollbackRelease: (input, context) => request("rollback-release", input, context),
        startPreview: (input, context) => request("start-preview", input, context),
        stopPreview: (input, context) => request("stop-preview", input, context),
        updateBranch: (input, context) => request("update-branch", input, context),
    };
    return Object.freeze(service);
}

function withDeliveryService(
    context: RequestContext,
    deliveryService: DeliveryService
): RequestContext & { readonly deliveryService: DeliveryService } {
    return { ...context, deliveryService };
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

describe("Delivery routes", () => {
    test("serves all five reads and reauthorizes all nine exact mutations", async () => {
        const calls: string[] = [];
        const contexts: DeliveryControlContext[] = [];
        let authorizationChecks = 0;
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["delivery:read", "delivery:write"]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    authorizeRecentMfa: () => {
                        authorizationChecks += 1;
                        return "authorized";
                    },
                }),
                requestId: "delivery-request-1",
            }
        );
        const caller = appRouter.createCaller(
            withDeliveryService(context, testService(calls, contexts))
        ).delivery;

        expect(await caller.listPullRequests({})).toEqual({
            checkedAtMs: 1000,
            state: "unavailable",
        });
        expect(await caller.listDeployments({})).toMatchObject({ state: "unavailable" });
        expect(await caller.getPreview({})).toMatchObject({ state: "unavailable" });
        expect(await caller.getProductionCheckout({})).toMatchObject({
            state: "unavailable",
        });
        expect(await caller.getReleases({})).toMatchObject({ state: "unavailable" });

        const results = await Promise.all([
            caller.approvePullRequest(approvePullRequestInput),
            caller.approveReview(approveReviewInput),
            caller.createPullRequestStack(createPullRequestStackInput),
            caller.deploy(deployInput),
            caller.rejectPullRequest(rejectPullRequestInput),
            caller.rollbackRelease(rollbackReleaseInput),
            caller.startPreview(startPreviewInput),
            caller.stopPreview(stopPreviewInput),
            caller.updateBranch(updateBranchInput),
        ]);

        expect(results.map(({ operation }) => operation)).toEqual([
            "merge-pull-request",
            "approve-review",
            "create-pull-request-stack",
            "deploy",
            "reject-pull-request",
            "rollback-release",
            "start-preview",
            "stop-preview",
            "update-branch",
        ]);
        expect(
            results.every(({ jobRunId: id, queued }) => id === jobRunId && queued)
        ).toBe(true);
        expect(authorizationChecks).toBe(18);
        expect(contexts).toHaveLength(9);
        expect(
            contexts.every(
                ({ actor, requestId }) =>
                    actor.authenticatorId === testSessionSelector &&
                    actor.id === testSecurityUserId &&
                    actor.kind === "user" &&
                    requestId === "delivery-request-1"
            )
        ).toBe(true);
        expect(calls).toEqual([
            "list-pull-requests",
            "list-deployments",
            "get-preview",
            "get-production-checkout",
            "get-releases",
            "approve-pull-request:merge-pull-request",
            "approve-review:approve-review",
            "create-pull-request-stack:create-pull-request-stack",
            "deploy:deploy",
            "reject-pull-request:reject-pull-request",
            "rollback-release:rollback-release",
            "start-preview:start-preview",
            "stop-preview:stop-preview",
            "update-branch:update-branch",
        ]);
    });

    test("rejects anonymous, automation, and capability-crossed callers", async () => {
        const calls: string[] = [];
        const deliveryService = testService(calls);
        const anonymous = appRouter.createCaller(
            withDeliveryService(await createTestRequestContext(), deliveryService)
        ).delivery;
        await expectCode(() => anonymous.listPullRequests({}), "UNAUTHORIZED");

        const automation = appRouter.createCaller(
            withDeliveryService(
                await createTestRequestContext(
                    createTestAutomationAuthentication([
                        "delivery:read",
                        "delivery:write",
                    ])
                ),
                deliveryService
            )
        ).delivery;
        await expectCode(() => automation.listPullRequests({}), "FORBIDDEN");
        await expectCode(
            () => automation.rejectPullRequest(rejectPullRequestInput),
            "FORBIDDEN"
        );

        const readOnly = appRouter.createCaller(
            withDeliveryService(
                await createTestRequestContext(
                    createTestSessionAuthentication(["delivery:read"])
                ),
                deliveryService
            )
        ).delivery;
        expect(await readOnly.listPullRequests({})).toMatchObject({
            state: "unavailable",
        });
        await expectCode(
            () => readOnly.rejectPullRequest(rejectPullRequestInput),
            "FORBIDDEN"
        );

        const writeOnly = appRouter.createCaller(
            withDeliveryService(
                await createTestRequestContext(
                    createTestSessionAuthentication(["delivery:write"])
                ),
                deliveryService
            )
        ).delivery;
        await expectCode(() => writeOnly.listPullRequests({}), "FORBIDDEN");
        expect(calls).toEqual(["list-pull-requests"]);
    });

    test("enforces recent MFA before dispatch and clears changed sessions", async () => {
        for (const [status, code, reason] of [
            ["mfa-enrollment-required", "FORBIDDEN", "mfa_enrollment_required"],
            ["step-up-required", "FORBIDDEN", "step_up_required"],
            ["session-changed", "UNAUTHORIZED", undefined],
        ] as const) {
            const calls: string[] = [];
            const responseHeaders = new Headers();
            const context = await createTestRequestContext(
                createTestSessionAuthentication(["delivery:write"]),
                createTestApplicationRuntime(),
                {
                    authenticationLifecycle: createTestAuthenticationLifecycleService({
                        authorizeRecentMfa: () => status,
                    }),
                    responseHeaders,
                }
            );
            const caller = appRouter.createCaller(
                withDeliveryService(context, testService(calls))
            ).delivery;

            const failure = await expectCode(
                () => caller.rejectPullRequest(rejectPullRequestInput),
                code
            );
            expect(calls).toEqual([]);
            if (reason === undefined) {
                expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
            } else {
                expect(failure).toHaveProperty("cause.reason", reason);
                expect(responseHeaders.has("set-cookie")).toBe(false);
            }
        }
    });

    test("clears a session that changes inside durable enqueue admission", async () => {
        const calls: string[] = [];
        const responseHeaders = new Headers();
        let authorizationChecks = 0;
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["delivery:write"]),
            createTestApplicationRuntime(),
            {
                authenticationLifecycle: createTestAuthenticationLifecycleService({
                    authorizeRecentMfa: () =>
                        authorizationChecks++ === 0 ? "authorized" : "session-changed",
                }),
                responseHeaders,
            }
        );
        const caller = appRouter.createCaller(
            withDeliveryService(context, testService(calls))
        ).delivery;

        await expectCode(
            () => caller.rejectPullRequest(rejectPullRequestInput),
            "UNAUTHORIZED"
        );
        expect(authorizationChecks).toBe(2);
        expect(responseHeaders.get("set-cookie")).toContain("Max-Age=0");
    });

    test("maps fixed domain failures without leaking private diagnostics", async () => {
        for (const [reason, code, expectedMessage] of [
            ["conflict", "CONFLICT", "Delivery state changed; reopen this confirmation"],
            ["not-found", "NOT_FOUND", "Delivery target was not found"],
            [
                "unknown-outcome",
                "SERVICE_UNAVAILABLE",
                "Delivery operation queue outcome could not be confirmed",
            ],
            [
                "audit-unavailable",
                "SERVICE_UNAVAILABLE",
                "Delivery is temporarily unavailable",
            ],
            ["unavailable", "SERVICE_UNAVAILABLE", "Delivery is temporarily unavailable"],
        ] as const) {
            const context = await createTestRequestContext(
                createTestSessionAuthentication(["delivery:write"])
            );
            const caller = appRouter.createCaller(
                withDeliveryService(
                    context,
                    testService(
                        [],
                        [],
                        new DeliveryServiceError(reason, {
                            cause: new Error("SECRET provider output"),
                        })
                    )
                )
            ).delivery;

            const failure = await expectCode(
                () => caller.approveReview(approveReviewInput),
                code
            );
            expect(failure.message).toBe(expectedMessage);
            expect(failure.message).not.toContain("SECRET provider output");
        }
    });

    test("sanitizes unavailable failures at every read and mutation boundary", async () => {
        const context = await createTestRequestContext(
            createTestSessionAuthentication(["delivery:read", "delivery:write"])
        );
        const caller = appRouter.createCaller(
            withDeliveryService(
                context,
                testService([], [], new DeliveryServiceError("unavailable"))
            )
        ).delivery;
        const operations = [
            () => caller.listPullRequests({}),
            () => caller.listDeployments({}),
            () => caller.getPreview({}),
            () => caller.getProductionCheckout({}),
            () => caller.getReleases({}),
            () => caller.approvePullRequest(approvePullRequestInput),
            () => caller.approveReview(approveReviewInput),
            () => caller.createPullRequestStack(createPullRequestStackInput),
            () => caller.deploy(deployInput),
            () => caller.rejectPullRequest(rejectPullRequestInput),
            () => caller.rollbackRelease(rollbackReleaseInput),
            () => caller.startPreview(startPreviewInput),
            () => caller.stopPreview(stopPreviewInput),
            () => caller.updateBranch(updateBranchInput),
        ];

        for (const operation of operations) {
            const failure = await expectCode(operation, "SERVICE_UNAVAILABLE");
            expect(failure.message).toBe("Delivery is temporarily unavailable");
        }
    });

    test("fails closed when the Delivery service is not composed", async () => {
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["delivery:read", "delivery:write"])
            )
        ).delivery;

        await expectCode(() => caller.listPullRequests({}), "SERVICE_UNAVAILABLE");
        await expectCode(
            () => caller.rejectPullRequest(rejectPullRequestInput),
            "SERVICE_UNAVAILABLE"
        );
    });
});
