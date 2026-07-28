import { json, jsonWithEtag, readJson } from "../http.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
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

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

function routeError(error: unknown, fallback = "Pull request route failed"): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

function parsePullRequestNumber(value: unknown): number | Response {
    try {
        return validatePrNumber(value);
    } catch (error) {
        return json(
            { error: errorMessage(error, "Invalid pull request number") },
            { status: 400 }
        );
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

function pullRequestSnapshotJson(request: Request | undefined, data: unknown): Response {
    return request ? jsonWithEtag(request, data) : json(data);
}

async function runPullRequestMutation<T>(operation: () => Promise<T>): Promise<T> {
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
                    ? await readJson<{ deploy?: unknown } | undefined>(request)
                    : undefined;
                return json(
                    await runPullRequestMutation(() =>
                        runPullRequestApproval(number, body?.deploy === true)
                    )
                );
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
                    ? await readJson<{ comment?: unknown } | undefined>(request)
                    : undefined;
                const comment =
                    typeof body?.comment === "string" && body.comment.trim()
                        ? body.comment.trim()
                        : "Closed from Mira Dashboard after Rajohan rejected it.";
                return json(
                    await runPullRequestMutation(() =>
                        runPullRequestRejection(number, comment)
                    )
                );
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
                return json(
                    await runPullRequestMutation(() =>
                        runPullRequestReviewApproval(number)
                    )
                );
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
                return json(
                    await runPullRequestMutation(() => runPullRequestBranchUpdate(number))
                );
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
                        },
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
                    });
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
                return json(
                    await runPullRequestMutation(async () => ({
                        deployment: await prepareAndStartDeployLatest(),
                        isOk: true,
                    }))
                );
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/deployments": {
        GET: () => {
            try {
                return json({ deployments: readDeploymentJobs() });
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/releases": {
        GET: async () => {
            try {
                return json({ release: await getDashboardReleaseStatus() });
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/releases/rollback": {
        POST: async (request: Request) => {
            try {
                const body = await readJson<{ targetCommit?: unknown } | null>(request);
                if (typeof body?.targetCommit !== "string") {
                    return json(
                        { error: "Rollback target commit is required" },
                        { status: 400 }
                    );
                }
                const targetCommit = body.targetCommit;
                return json(
                    await runPullRequestMutation(async () => ({
                        deployment: await prepareAndStartRollback(targetCommit),
                        isOk: true,
                    }))
                );
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/production-checkout": {
        GET: async () => {
            try {
                return json({ checkout: await productionCheckoutSnapshot.read() });
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/preview": {
        GET: async () => {
            try {
                return json({ preview: await pullRequestPreviewSnapshot.read() });
            } catch (error) {
                return routeError(error, "PR preview status failed");
            }
        },
    },
} as const;
