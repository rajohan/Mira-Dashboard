import { parseDockerExecStartRequest } from "../../../../contracts/docker/operations.ts";
import { database } from "../../database/connection.ts";
import { json } from "../../http/core.ts";
import { routeErrorResponse, routeFailureResponse } from "../../http/routeSupport.ts";
import { stringFallback } from "../../lib/values.ts";
import { resolveContainerId } from "../../services/docker/inventory.ts";
import {
    enqueueJobExecution,
    getJobExecution,
    type JobExecutionRecord,
} from "../../services/jobExecutionQueue/repository.ts";
import { cancelJobExecution } from "../../services/jobExecutionQueue/worker.ts";
import { outputNumber, outputString } from "./mutationExecution.ts";
import { parameters, readDockerJson } from "./request.ts";

const MAX_JOBS = 100;

function dockerExecExecution(jobId: string): JobExecutionRecord | undefined {
    const execution = getJobExecution(jobId);
    return execution?.actionKey === "docker.exec" ? execution : undefined;
}

export const dockerExecRoutes = {
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
} as const;
