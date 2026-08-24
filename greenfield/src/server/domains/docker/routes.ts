import { TRPCError } from "@trpc/server";

import {
    dockerGetContainerLogsInputSchema,
    dockerGetContainerLogsResultSchema,
    dockerOverviewInputSchema,
    dockerOverviewSchema,
    dockerPreparePruneInputSchema,
    dockerPreparePruneResultSchema,
    dockerRequestOperationInputSchema,
    dockerRequestOperationResultSchema,
} from "../../../contracts/docker.ts";
import { appendClearedDashboardSessionCookie } from "../../rawHttp/sessionCookie.ts";
import type { RequestContext } from "../../trpc/context.ts";
import {
    authenticationPolicyError,
    operationOutcomeUnknownError,
    router,
    sessionCapabilityProcedure,
} from "../../trpc/trpc.ts";
import type { AuthenticatedBrowserIdentity } from "../security/authenticationSession.ts";
import { sessionActor } from "../security/authenticationSession.ts";
import {
    type DockerControlContext,
    type DockerService,
    DockerServiceError,
} from "./service.ts";

function service(context: RequestContext): DockerService {
    const candidate = context.dockerService;
    if (candidate === undefined) throw new DockerServiceError("unavailable");
    return candidate;
}

function authorizeControl(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): void {
    const status = context.authenticationLifecycle.authorizeRecentMfa(
        context.sessionIdentity
    );
    switch (status) {
        case "authorized": {
            return;
        }
        case "mfa-enrollment-required": {
            throw authenticationPolicyError(
                "mfa_enrollment_required",
                "Multi-factor authentication enrollment is required"
            );
        }
        case "step-up-required": {
            throw authenticationPolicyError(
                "step_up_required",
                "Recent multi-factor authentication is required"
            );
        }
        case "session-changed": {
            appendClearedDashboardSessionCookie(context.responseHeaders);
            throw new TRPCError({
                code: "UNAUTHORIZED",
                message: "Authentication state changed; sign in again",
            });
        }
    }
}

function controlContext(
    context: RequestContext & {
        readonly sessionIdentity: AuthenticatedBrowserIdentity;
    }
): DockerControlContext {
    return {
        actor: sessionActor(context.sessionIdentity),
        reauthorize: () => authorizeControl(context),
        requestId: context.requestId,
    };
}

function throwServiceFailure(error: unknown): never {
    if (!(error instanceof DockerServiceError)) throw error;
    switch (error.reason) {
        case "conflict": {
            throw new TRPCError({
                cause: error,
                code: "CONFLICT",
                message: "Docker state changed; refresh before retrying",
            });
        }
        case "not-found": {
            throw new TRPCError({
                cause: error,
                code: "NOT_FOUND",
                message: "Docker target was not found",
            });
        }
        case "unknown-outcome": {
            throw operationOutcomeUnknownError(
                "Docker operation queue outcome could not be confirmed"
            );
        }
        case "audit-unavailable":
        case "unavailable": {
            throw new TRPCError({
                cause: error,
                code: "SERVICE_UNAVAILABLE",
                message: "Docker operations are temporarily unavailable",
            });
        }
    }
}

const readProcedure = sessionCapabilityProcedure("docker:read");
const controlProcedure = sessionCapabilityProcedure("docker:write");

/** Session-only Docker reads and recent-MFA exact durable mutation requests. */
export const dockerRoutes = {
    getContainerLogs: readProcedure
        .input(dockerGetContainerLogsInputSchema)
        .output(dockerGetContainerLogsResultSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await service(ctx).getContainerLogs(input, signal);
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    overview: readProcedure
        .input(dockerOverviewInputSchema)
        .output(dockerOverviewSchema)
        .query(({ ctx }) => {
            try {
                return service(ctx).overview();
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    preparePrune: readProcedure
        .input(dockerPreparePruneInputSchema)
        .output(dockerPreparePruneResultSchema)
        .query(async ({ ctx, input, signal }) => {
            try {
                return await service(ctx).preparePrune(
                    input,
                    { actor: sessionActor(ctx.sessionIdentity) },
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
    requestOperation: controlProcedure
        .input(dockerRequestOperationInputSchema)
        .output(dockerRequestOperationResultSchema)
        .mutation(async ({ ctx, input, signal }) => {
            authorizeControl(ctx);
            try {
                return await service(ctx).requestOperation(
                    input,
                    controlContext(ctx),
                    signal
                );
            } catch (error) {
                return throwServiceFailure(error);
            }
        }),
};

/** Leaf procedure names owned by the Docker router. */
export const dockerProcedureNames = Object.freeze(Object.keys(dockerRoutes));

/** Session-only bounded Docker observability and purpose-built operation router. */
export const dockerRouter = router(dockerRoutes);
