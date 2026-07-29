import type {
    DashboardReleaseStatusResponse,
    DeploymentActionResponse,
    DeploymentsResponse,
    ProductionCheckoutResponse,
    PullRequestActionResponse,
    PullRequestPreviewMutationResponse,
    PullRequestPreviewResponse,
    PullRequestsResponse,
} from "../../../contracts/delivery.ts";
import {
    parseDashboardRollbackRequest,
    parsePullRequestApproveRequest,
    parsePullRequestRejectRequest,
} from "../../../contracts/delivery.ts";
import { json, jsonWithEtag } from "../http.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";
import {
    type ParametersRequest,
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    getPullRequestPreviewStatus,
    prepareAndStartPullRequestPreview,
    prepareAndStopPullRequestPreview,
    reconcileClosedPullRequestPreview,
} from "../services/pullRequestPreviews.ts";
import {
    getDashboardReleaseStatus,
    getProductionCheckoutStatus,
    listDashboardPullRequests,
    prepareAndStartDeployLatest,
    prepareAndStartRollback,
    readDeploymentJobs,
    runPullRequestApproval,
    runPullRequestBranchUpdate,
    runPullRequestRejection,
    runPullRequestReviewApproval,
    validatePrNumber,
} from "../services/pullRequests.ts";

function routeError(error: unknown, fallback = "Pull request route failed"): Response {
    return routeErrorResponse(undefined, error, {
        code: "pull_request_failed",
        context: "pull-request",
        message: fallback,
    });
}

function parsePullRequestNumber(value: unknown): number | Response {
    try {
        return validatePrNumber(value);
    } catch {
        return routeFailureResponse({
            code: "invalid_pull_request_number",
            context: "pull-request",
            message: "Invalid pull request number",
            status: 400,
        });
    }
}

const pullRequestPreviewSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof getPullRequestPreviewStatus>>
>({
    freshForMs: 2000,
    load: getPullRequestPreviewStatus,
    name: "git.pull-request-preview",
    staleForMs: 10_000,
});

const pullRequestListSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof listDashboardPullRequests>>
>({
    freshForMs: 15_000,
    load: async () => {
        const pullRequests = await listDashboardPullRequests();
        await reconcileClosedPullRequestPreview(pullRequests);
        pullRequestPreviewSnapshot.invalidate();
        return pullRequests;
    },
    name: "github.pull-requests",
    staleForMs: 120_000,
});

const productionCheckoutSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof getProductionCheckoutStatus>>
>({
    freshForMs: 3000,
    load: () => getProductionCheckoutStatus(),
    name: "git.production-checkout",
    staleForMs: 30_000,
});

function pullRequestSnapshotJson(
    request: Request | undefined,
    data: PullRequestsResponse
): Response {
    return request ? jsonWithEtag(request, data) : json(data);
}

async function runPullRequestMutation<T>(operation: () => Promise<T> | T): Promise<T> {
    try {
        return await operation();
    } finally {
        pullRequestListSnapshot.invalidate();
        productionCheckoutSnapshot.invalidate();
    }
}

export const pullRequestRoutes = {
    "/api/pull-requests": {
        GET: async (request?: Request) => {
            try {
                return pullRequestSnapshotJson(request, {
                    pullRequests: await pullRequestListSnapshot.read(),
                });
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/:number/approve": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            try {
                const body = request.body
                    ? await readApiJsonOrError(request, parsePullRequestApproveRequest, {
                          code: "invalid_pull_request_approval",
                          context: "pull-request.approve",
                          message: "Invalid pull request approval",
                      })
                    : {};
                if (body instanceof Response) return body;
                const response = await runPullRequestMutation(() =>
                    runPullRequestApproval(number, body?.deploy === true)
                );
                return json(response satisfies PullRequestActionResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/:number/reject": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            try {
                const body = request.body
                    ? await readApiJsonOrError(request, parsePullRequestRejectRequest, {
                          code: "invalid_pull_request_rejection",
                          context: "pull-request.reject",
                          message: "Invalid pull request rejection",
                      })
                    : {};
                if (body instanceof Response) return body;
                const comment =
                    typeof body?.comment === "string" && body.comment.trim()
                        ? body.comment.trim()
                        : "Closed from Mira Dashboard after Rajohan rejected it.";
                const response = await runPullRequestMutation(() =>
                    runPullRequestRejection(number, comment)
                );
                return json(response satisfies PullRequestActionResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/:number/review-approval": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            try {
                const response = await runPullRequestMutation(() =>
                    runPullRequestReviewApproval(number)
                );
                return json(response satisfies PullRequestActionResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/:number/update-branch": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            try {
                const response = await runPullRequestMutation(() =>
                    runPullRequestBranchUpdate(number)
                );
                return json(response satisfies PullRequestActionResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/:number/preview/start": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            try {
                try {
                    return json(
                        {
                            isOk: true,
                            preview: await prepareAndStartPullRequestPreview(number),
                        } satisfies PullRequestPreviewMutationResponse,
                        { status: 202 }
                    );
                } finally {
                    pullRequestPreviewSnapshot.invalidate();
                }
            } catch (error) {
                return routeError(error, "PR preview startup failed");
            }
        },
    },
    "/api/pull-requests/:number/preview/stop": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            try {
                try {
                    return json({
                        isOk: true,
                        preview: await prepareAndStopPullRequestPreview(number),
                    } satisfies PullRequestPreviewMutationResponse);
                } finally {
                    pullRequestPreviewSnapshot.invalidate();
                }
            } catch (error) {
                return routeError(error, "PR preview stop failed");
            }
        },
    },
    "/api/pull-requests/deploy": {
        POST: async () => {
            try {
                const response = await runPullRequestMutation(() => ({
                    deployment: prepareAndStartDeployLatest(),
                    isOk: true as const,
                }));
                return json(response satisfies DeploymentActionResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/deployments": {
        GET: () => {
            try {
                return json({
                    deployments: readDeploymentJobs(),
                } satisfies DeploymentsResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/releases": {
        GET: async () => {
            try {
                return json({
                    release: await getDashboardReleaseStatus(),
                } satisfies DashboardReleaseStatusResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/releases/rollback": {
        POST: async (request: Request) => {
            try {
                const body = await readApiJsonOrError(
                    request,
                    parseDashboardRollbackRequest,
                    {
                        code: "invalid_rollback_request",
                        context: "pull-request.rollback",
                        message: "Invalid rollback request",
                    }
                );
                if (body instanceof Response) return body;
                const targetCommit = body.targetCommit;
                const response = await runPullRequestMutation(async () => ({
                    deployment: await prepareAndStartRollback(targetCommit),
                    isOk: true as const,
                }));
                return json(response satisfies DeploymentActionResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/production-checkout": {
        GET: async () => {
            try {
                return json({
                    checkout: await productionCheckoutSnapshot.read(),
                } satisfies ProductionCheckoutResponse);
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/preview": {
        GET: async () => {
            try {
                return json({
                    preview: await pullRequestPreviewSnapshot.read(),
                } satisfies PullRequestPreviewResponse);
            } catch (error) {
                return routeError(error, "PR preview status failed");
            }
        },
    },
} as const;
