import { json } from "../../http/core.ts";
import { routeErrorResponse, routeFailureResponse } from "../../http/routeSupport.ts";
import {
    blockingDockerUpdaterFailures,
    dockerUpdaterSteps,
    getDockerUpdaterEvents,
    getDockerUpdaterServiceById,
    getDockerUpdaterServices,
    getDockerUpdaterSummary,
    updaterResultCode,
} from "../../services/docker/updaterProjection.ts";
import type { DockerUpdaterStepResult } from "../../services/dockerUpdater/types.ts";
import { enqueueJobExecution } from "../../services/jobExecutionQueue/repository.ts";
import { enqueueScheduledJob } from "../../services/scheduledJobs/enqueue.ts";
import { waitForDockerMutationExecution } from "./mutationExecution.ts";
import { parseServiceId, queryNumber } from "./request.ts";

export const dockerUpdaterRoutes = {
    "/api/docker/updater/events": {
        GET: (request: Request) =>
            json({
                events: getDockerUpdaterEvents(queryNumber(request, "limit", 50)),
            }),
    },
    "/api/docker/updater/run": {
        POST: async (request: Request) => {
            try {
                const scheduledRun = enqueueScheduledJob("docker.updater", "manual");
                const execution = await waitForDockerMutationExecution(
                    scheduledRun.executionId as string,
                    60 * 60 * 1000
                );
                const steps = dockerUpdaterSteps(execution);
                return json({
                    isSuccess: blockingDockerUpdaterFailures(steps).length === 0,
                    steps,
                });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "docker_updater_failed",
                    context: "docker.updater",
                    message: "Docker updater failed",
                });
            }
        },
    },
    "/api/docker/updater/services": {
        GET: () => {
            const services = getDockerUpdaterServices();
            return json({
                services,
                summary: getDockerUpdaterSummary(services),
            });
        },
    },
    "/api/docker/updater/services/:serviceId/update": {
        POST: async (request: Request) => {
            const serviceId = parseServiceId(request);
            if (serviceId === undefined) {
                return routeFailureResponse({
                    context: "docker",
                    message: "Invalid service id",
                    status: 400,
                });
            }
            const service = getDockerUpdaterServiceById(serviceId);
            if (!service) {
                return routeFailureResponse({
                    context: "docker",
                    message: "Updater service not found",
                    status: 404,
                });
            }
            if (!service.enabled) {
                return routeFailureResponse({
                    context: "docker",
                    message: "Updater service is disabled",
                    status: 400,
                });
            }
            let steps: DockerUpdaterStepResult[];
            try {
                const execution = enqueueJobExecution({
                    actionKey: "docker.updater",
                    displayName: `Update Docker service ${serviceId}`,
                    payload: { serviceId },
                    resourceClass: "exclusive",
                    timeoutMs: 30 * 60 * 1000,
                });
                steps = dockerUpdaterSteps(
                    await waitForDockerMutationExecution(execution.id, 60 * 60 * 1000)
                );
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "docker_updater_failed",
                    context: "docker.updater",
                    message: "Docker updater failed",
                });
            }
            const failed = blockingDockerUpdaterFailures(steps);
            const code = updaterResultCode(failed);
            const firstFailure = failed[0];
            if (firstFailure && code === "NOT_FOUND") {
                return routeFailureResponse({
                    code: "updater_service_not_found",
                    context: "docker.updater",
                    message: "Updater service not found",
                    status: 404,
                });
            }
            if (firstFailure && code === "DISABLED") {
                return routeFailureResponse({
                    code: "updater_service_disabled",
                    context: "docker.updater",
                    message: "Updater service is disabled",
                    status: 400,
                });
            }
            if (firstFailure && code === "CONFLICT") {
                return routeFailureResponse({
                    code: "update_conflict",
                    context: "docker.updater",
                    message: "No update available",
                    status: 409,
                });
            }
            if (firstFailure && code === "UNSUPPORTED_REGISTRY") {
                return routeFailureResponse({
                    code: "unsupported_registry",
                    context: "docker.updater",
                    message: "Unsupported image registry",
                    status: 422,
                });
            }
            const updatedService = getDockerUpdaterServiceById(serviceId);
            return json({
                isSuccess: failed.length === 0,
                result: {
                    failed,
                    serviceId,
                    summary: {
                        failed: failed.length,
                        updated: failed.length === 0 ? 1 : 0,
                    },
                    updated: failed.length === 0 ? [serviceId] : [],
                },
                service: updatedService,
                stderr: failed
                    .map((step) => step.stderr)
                    .filter(Boolean)
                    .join("\n"),
            });
        },
    },
} as const;
