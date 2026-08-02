import {
    type DockerContainersResponse,
    parseDockerContainerActionRequest,
    parseDockerExecStartRequest,
    parseDockerPruneRequest,
    parseDockerStackActionRequest,
    parseDockerSummaryCache,
} from "../../../contracts/docker.ts";
import type { ContractParser } from "../../../contracts/runtime.ts";
import { database } from "../database.ts";
import { json, jsonWithEtag } from "../http.ts";
import { getCacheEntry } from "../lib/cacheStore.ts";
import { CoalescedSnapshot } from "../lib/coalescedSnapshot.ts";
import { stringFallback } from "../lib/values.ts";
import { isDevelopmentSafeMode } from "../requestPolicy.ts";
import {
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    getContainerDetails,
    getContainerLogs,
    getContainers,
    getContainerStatsRows,
    getImages,
    getVolumes,
    resolveContainerId,
} from "../services/docker/inventory.ts";
import {
    blockingDockerUpdaterFailures,
    dockerUpdaterSteps,
    getDockerUpdaterEvents,
    getDockerUpdaterServiceById,
    getDockerUpdaterServices,
    getDockerUpdaterSummary,
    updaterResultCode,
} from "../services/docker/updaterProjection.ts";
import type { DockerUpdaterStepResult } from "../services/dockerUpdater.ts";
import {
    cancelJobExecution,
    enqueueJobExecution,
    getJobExecution,
    type JobExecutionRecord,
} from "../services/jobExecutionQueue.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "../services/queuedJobExecution.ts";
import { enqueueScheduledJob } from "../services/scheduledJobs.ts";

export {
    getContainers,
    getContainerStatsRows,
    getImages,
    getVolumes,
} from "../services/docker/inventory.ts";
export {
    getDockerUpdaterEvents,
    getDockerUpdaterServices,
    getDockerUpdaterSummary,
} from "../services/docker/updaterProjection.ts";

const MAX_JOBS = 100;
const MIN_LOG_TAIL = 50;
const MAX_LOG_TAIL = 5000;
function parameters(request: Request): Record<string, string | undefined> {
    return (request as Request & { params?: Record<string, string> }).params ?? {};
}

function queryNumber(request: Request, key: string, fallback: number): number {
    const rawValue = new URL(request.url).searchParams.get(key);
    if (rawValue === null || rawValue === "") return fallback;
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function dockerIdentifier(value: unknown): string | undefined {
    const identifier = stringFallback(value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(identifier)) return undefined;
    return identifier;
}

function dockerImageIdentifier(value: unknown): string | undefined {
    const identifier = stringFallback(value).trim();
    if (/^sha256:[a-f0-9]{64}$/iu.test(identifier)) return identifier;
    return dockerIdentifier(identifier);
}

function invalidDockerIdentifier(label: string): Response {
    return routeFailureResponse({
        context: "docker",
        message: `Invalid ${label}`,
        status: 400,
    });
}

function parseJsonField<T>(value: string | undefined): T | undefined {
    if (!value) return undefined;
    try {
        return JSON.parse(value) as T;
    } catch {
        return undefined;
    }
}

async function readDockerJson<T>(
    request: Request,
    parser: ContractParser<T>
): Promise<T | Response> {
    return readApiJsonOrError(request, parser, {
        code: "invalid_docker_request",
        context: "docker.body",
        message: "Invalid Docker request",
    });
}

function parseServiceId(request: Request): number | undefined {
    const rawValue = parameters(request).serviceId;
    if (!rawValue || !/^\d+$/u.test(rawValue)) return undefined;
    const serviceId = Number(rawValue);
    return Number.isSafeInteger(serviceId) && serviceId > 0 ? serviceId : undefined;
}

async function runQueuedDockerAction(options: {
    actionKey: string;
    displayName: string;
    payload?: Record<string, unknown>;
    resourceClass?: "host-heavy" | "interactive" | "exclusive";
    timeoutMs: number;
}): Promise<Record<string, unknown>> {
    const execution = enqueueJobExecution({
        actionKey: options.actionKey,
        displayName: options.displayName,
        payload: options.payload,
        resourceClass: options.resourceClass ?? "host-heavy",
        timeoutMs: options.timeoutMs,
    });
    return successfulJobExecutionOutput(
        await waitForDockerMutationExecution(
            execution.id,
            options.timeoutMs + 30 * 60 * 1000
        )
    );
}

async function waitForDockerMutationExecution(executionId: string, timeoutMs: number) {
    try {
        return await waitForJobExecution(executionId, { timeoutMs });
    } finally {
        invalidateDockerReadSnapshots();
    }
}

function outputString(output: Record<string, unknown>, key: string): string {
    return typeof output[key] === "string" ? output[key] : "";
}

function outputNumber(output: Record<string, unknown>, key: string): number | undefined {
    return typeof output[key] === "number" && Number.isFinite(output[key])
        ? output[key]
        : undefined;
}

function dockerExecExecution(jobId: string): JobExecutionRecord | undefined {
    const execution = getJobExecution(jobId);
    return execution?.actionKey === "docker.exec" ? execution : undefined;
}

async function runStackAction(request: Request): Promise<Response> {
    const body = await readDockerJson(request, parseDockerStackActionRequest);
    if (body instanceof Response) return body;
    const result = await runQueuedDockerAction({
        actionKey: "docker.stack.action",
        displayName: `Docker stack ${body.action}`,
        payload: { action: body.action, service: body.service },
        timeoutMs: 2 * 60 * 1000,
    });
    return json({
        output: outputString(result, "output"),
    });
}

const dockerStatsSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof getContainerStatsRows>>
>({
    freshForMs: 2000,
    load: getContainerStatsRows,
    name: "docker.stats",
    staleForMs: 15_000,
});

const dockerStateSnapshot = new CoalescedSnapshot<
    Awaited<ReturnType<typeof getContainers>>
>({
    freshForMs: 2000,
    load: async () => getContainers(await dockerStatsSnapshot.read()),
    name: "docker.state",
    staleForMs: 15_000,
});

/**
 * Returns the shared read-only container sampler for polling routes.
 * @returns the shared read-only container sampler for polling routes.
 */
export async function getDockerContainersSnapshot() {
    return await dockerStateSnapshot.read();
}

function invalidateDockerReadSnapshots(): void {
    dockerStateSnapshot.invalidate();
    dockerStatsSnapshot.invalidate();
}

function dockerSnapshotJson(request: Request | undefined, data: unknown): Response {
    return request ? jsonWithEtag(request, data) : json(data);
}

function getIsolatedDockerContainers() {
    const entry = getCacheEntry("docker.summary");
    const snapshot = parseJsonField<unknown>(entry?.data);
    if (!entry || snapshot === undefined) {
        throw new Error("Isolated Docker snapshot is unavailable");
    }
    return parseDockerSummaryCache(snapshot, "docker.summary").containers;
}

export const dockerRoutes = {
    "/api/docker/containers": {
        GET: async (request?: Request) => {
            const mode = isDevelopmentSafeMode() ? "isolated" : "live";
            const response = {
                containers:
                    mode === "isolated"
                        ? getIsolatedDockerContainers()
                        : await getDockerContainersSnapshot(),
                mode,
            } satisfies DockerContainersResponse;
            return dockerSnapshotJson(request, response);
        },
    },
    "/api/docker/containers/stats": {
        GET: async (request?: Request) => {
            const statsRows = await dockerStatsSnapshot.read();
            return dockerSnapshotJson(request, {
                stats: statsRows.map((row) => ({
                    blockIO: row.BlockIO,
                    cpu: row.CPUPerc,
                    id: row.ID,
                    memory: row.MemUsage,
                    memoryPercent: row.MemPerc,
                    netIO: row.NetIO,
                    pids: row.PIDs,
                })),
            });
        },
    },
    "/api/docker/containers/:containerId": {
        GET: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const details = await getContainerDetails(containerId);
            return details
                ? json(details)
                : routeFailureResponse({
                      context: "docker",
                      message: "Container not found",
                      status: 404,
                  });
        },
    },
    "/api/docker/containers/:containerId/action": {
        POST: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const body = await readDockerJson(request, parseDockerContainerActionRequest);
            if (body instanceof Response) return body;
            const action = body.action;
            const details = await getContainerDetails(containerId);
            if (!details)
                return routeFailureResponse({
                    context: "docker",
                    message: "Container not found",
                    status: 404,
                });
            await runQueuedDockerAction({
                actionKey: "docker.container.action",
                displayName: `Docker container ${action}`,
                payload: { action, containerId: details.id },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ output: `${action} sent to ${details.name}` });
        },
    },
    "/api/docker/containers/:containerId/logs": {
        GET: async (request: Request) => {
            const containerId = dockerIdentifier(parameters(request).containerId);
            if (!containerId) return invalidDockerIdentifier("containerId");
            const requestedTail = Math.trunc(queryNumber(request, "tail", 200)) || 200;
            const tail = Math.min(MAX_LOG_TAIL, Math.max(MIN_LOG_TAIL, requestedTail));
            return json({ content: await getContainerLogs(containerId, tail) });
        },
    },
    "/api/docker/exec/:jobId": {
        GET: (request: Request) => {
            const jobId = stringFallback(parameters(request).jobId);
            const execution = dockerExecExecution(jobId);
            if (!execution)
                return routeFailureResponse({
                    context: "docker",
                    message: "Docker exec job not found",
                    status: 404,
                });
            const output = execution.output;
            const isTerminal = ["success", "failed", "cancelled"].includes(
                execution.status
            );
            return json({
                code: outputNumber(output, "code"),
                containerId:
                    outputString(output, "containerId") ||
                    stringFallback(execution.payload.containerId),
                endedAt: isTerminal
                    ? (outputNumber(output, "endedAt") ??
                      (execution.finishedAt
                          ? Date.parse(execution.finishedAt)
                          : undefined))
                    : undefined,
                jobId: execution.id,
                startedAt:
                    outputNumber(output, "startedAt") ??
                    Date.parse(execution.startedAt ?? execution.queuedAt),
                status: isTerminal ? "done" : "running",
                stderr: outputString(output, "stderr"),
                stdout: outputString(output, "stdout"),
            });
        },
    },
    "/api/docker/exec/:jobId/stop": {
        POST: (request: Request) => {
            const jobId = stringFallback(parameters(request).jobId);
            const execution = dockerExecExecution(jobId);
            if (!execution)
                return routeFailureResponse({
                    context: "docker",
                    message: "Docker exec job not found",
                    status: 404,
                });
            if (execution.status !== "queued" && execution.status !== "running") {
                return routeFailureResponse({
                    context: "docker",
                    message: "Job is not running",
                    status: 400,
                });
            }
            try {
                cancelJobExecution(execution.id);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "docker_exec_stop_failed",
                    context: "docker.exec.stop",
                    message: "Failed to stop Docker exec job",
                });
            }
            return json({ isSuccess: true });
        },
    },
    "/api/docker/exec/start": {
        POST: async (request: Request) => {
            const body = await readDockerJson(request, parseDockerExecStartRequest);
            if (body instanceof Response) return body;
            const containerId = await resolveContainerId(body.containerId);
            if (!containerId) {
                return routeFailureResponse({
                    context: "docker",
                    message: "Container not found",
                    status: 404,
                });
            }
            const activeJobs = database
                .prepare(
                    `SELECT COUNT(*) AS count FROM job_executions
                     WHERE action_key = 'docker.exec'
                       AND status IN ('queued', 'running')`
                )
                .get() as { count: number };
            if (activeJobs.count >= MAX_JOBS) {
                return routeFailureResponse({
                    context: "docker",
                    message: "Too many active Docker exec jobs",
                    status: 429,
                });
            }
            let execution: JobExecutionRecord;
            try {
                execution = enqueueJobExecution({
                    actionKey: "docker.exec",
                    displayName: "Docker container exec",
                    payload: { command: body.command, containerId },
                    resourceClass: "exclusive",
                    timeoutMs: 7 * 60 * 60 * 1000,
                });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "docker_exec_start_failed",
                    context: "docker.exec.start",
                    message: "Docker exec failed to start",
                });
            }
            return json({ jobId: execution.id });
        },
    },
    "/api/docker/images": {
        GET: async () => json({ images: await getImages() }),
    },
    "/api/docker/images/:imageId": {
        DELETE: async (request: Request) => {
            const imageId = dockerImageIdentifier(parameters(request).imageId);
            if (!imageId) return invalidDockerIdentifier("imageId");
            await runQueuedDockerAction({
                actionKey: "docker.image.delete",
                displayName: "Delete Docker image",
                payload: { imageId },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ isSuccess: true });
        },
    },
    "/api/docker/prune": {
        POST: async (request: Request) => {
            const body = await readDockerJson(request, parseDockerPruneRequest);
            if (body instanceof Response) return body;
            if (body.target === "images") {
                return json({
                    isSuccess: true,
                    output: outputString(
                        await runQueuedDockerAction({
                            actionKey: "docker.prune.images",
                            displayName: "Prune Docker images",
                            payload: { target: "images" },
                            timeoutMs: 10 * 60 * 1000,
                        }),
                        "output"
                    ),
                });
            }
            return json({
                isSuccess: true,
                output: outputString(
                    await runQueuedDockerAction({
                        actionKey: "docker.prune.volumes",
                        displayName: "Prune Docker volumes",
                        payload: { target: "volumes" },
                        timeoutMs: 10 * 60 * 1000,
                    }),
                    "output"
                ),
            });
        },
    },
    "/api/docker/stack/action": {
        POST: runStackAction,
    },
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
    "/api/docker/volumes": {
        GET: async () => json({ volumes: await getVolumes() }),
    },
    "/api/docker/volumes/:volumeName": {
        DELETE: async (request: Request) => {
            const volumeName = dockerIdentifier(parameters(request).volumeName);
            if (!volumeName) return invalidDockerIdentifier("volumeName");
            await runQueuedDockerAction({
                actionKey: "docker.volume.delete",
                displayName: "Delete Docker volume",
                payload: { volumeName },
                timeoutMs: 2 * 60 * 1000,
            });
            return json({ isSuccess: true });
        },
    },
} as const;
