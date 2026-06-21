import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    approvePullRequest,
    approvePullRequestReview,
    ensureProductionCheckout,
    ensureProductionReadyForDeploy,
    getProductionCheckoutStatus,
    listDashboardPullRequests,
    readDeploymentJobs,
    rejectPullRequest,
    startDeployLatest,
    updatePullRequestBranch,
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
            const body = request.body
                ? await readJson<{ deploy?: unknown } | null>(request)
                : null;
            try {
                return json(await approvePullRequest(number, body?.deploy === true));
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/:number/reject": {
        POST: async (request: ParametersRequest<"number">) => {
            const number = parsePullRequestNumber(request.params.number);
            if (number instanceof Response) return number;
            const body = request.body
                ? await readJson<{ comment?: unknown } | null>(request)
                : null;
            const comment =
                typeof body?.comment === "string" && body.comment.trim()
                    ? body.comment.trim()
                    : "Closed from Mira Dashboard after Rajohan rejected it.";
            try {
                return json(await rejectPullRequest(number, comment));
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
                return json(await approvePullRequestReview(number));
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
                return json(await updatePullRequestBranch(number));
            } catch (error) {
                return routeError(error);
            }
        },
    },
    "/api/pull-requests/deploy": {
        POST: async () => {
            try {
                await ensureProductionCheckout();
                await ensureProductionReadyForDeploy();
                return json({ deployment: startDeployLatest(), isOk: true });
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
    "/api/pull-requests/production-checkout": {
        GET: async () => {
            try {
                return json({ checkout: await getProductionCheckoutStatus() });
            } catch (error) {
                return routeError(error);
            }
        },
    },
} as const;
