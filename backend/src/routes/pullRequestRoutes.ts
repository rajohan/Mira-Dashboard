import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    getPullRequestPreviewStatus,
    prepareAndStartPullRequestPreview,
    prepareAndStopPullRequestPreview,
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

export const pullRequestRoutes = {
    "/api/pull-requests": {
        GET: async () => {
            try {
                return json({ pullRequests: await listDashboardPullRequests() });
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
                return json(await runPullRequestApproval(number, body?.deploy === true));
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
                return json(await runPullRequestRejection(number, comment));
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
                return json(await runPullRequestReviewApproval(number));
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
                return json(await runPullRequestBranchUpdate(number));
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
                return json(
                    {
                        isOk: true,
                        preview: await prepareAndStartPullRequestPreview(number),
                    },
                    { status: 202 }
                );
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
                return json({
                    isOk: true,
                    preview: await prepareAndStopPullRequestPreview(number),
                });
            } catch (error) {
                return routeError(error, "PR preview stop failed");
            }
        },
    },
    "/api/pull-requests/deploy": {
        POST: async () => {
            try {
                return json({
                    deployment: await prepareAndStartDeployLatest(),
                    isOk: true,
                });
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
                return json({
                    deployment: await prepareAndStartRollback(body.targetCommit),
                    isOk: true,
                });
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/production-checkout": {
        GET: async () => {
            try {
                return json({ checkout: await getProductionCheckoutStatus() });
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/preview": {
        GET: async () => {
            try {
                return json({ preview: await getPullRequestPreviewStatus() });
            } catch (error) {
                return routeError(error, "PR preview status failed");
            }
        },
    },
} as const;
