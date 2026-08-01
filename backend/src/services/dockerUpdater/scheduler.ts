import { database } from "../../database.ts";
import {
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    ScheduledJobActionError,
    upsertScheduledJob,
} from "../scheduledJobs.ts";
import { createNotificationBestEffort } from "./notifications.ts";
import type { DockerUpdaterStepResult } from "./types.ts";
import {
    isNonblockingRegistrationFailure,
    runDockerUpdaterService,
} from "./updatePolicy.ts";

function skippedGitSyncDetails(
    step: DockerUpdaterStepResult
): Record<string, unknown> | undefined {
    if (step.kind !== "git-sync" || !step.isOk || !step.stdout) {
        return undefined;
    }
    try {
        const details = JSON.parse(step.stdout) as Record<string, unknown>;
        return details.pushed === false && typeof details.skippedReason === "string"
            ? details
            : undefined;
    } catch {
        return undefined;
    }
}

export function registerDockerUpdaterScheduledJobs(): void {
    const job = {
        id: "docker.updater",
        name: "Docker updater",
        description: "Poll Docker registries and apply approved automatic updates.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "04:10",
        actionKey: "docker.updater",
        actionPayload: {},
        resourceClass: "exclusive",
    } as const;
    registerScheduledJobAction(
        "docker.updater",
        async (executionJob, signal, context) => {
            const rawServiceId = executionJob.actionPayload.serviceId;
            let serviceId: number | undefined = Number.NaN;
            if (rawServiceId === undefined) {
                serviceId = undefined;
            }
            if (
                typeof rawServiceId === "number" &&
                Number.isSafeInteger(rawServiceId) &&
                rawServiceId > 0
            ) {
                serviceId = rawServiceId;
            }
            if (Number.isNaN(serviceId)) {
                throw Object.assign(new Error("Invalid Docker updater service id"), {
                    statusCode: 400,
                });
            }
            const steps = await runDockerUpdaterService(
                serviceId,
                signal,
                context.protectFromCancellation
            );
            for (const step of steps) {
                const details = skippedGitSyncDetails(step);
                if (!details) continue;
                createNotificationBestEffort(
                    "Docker updater repository sync skipped",
                    String(details.skippedReason),
                    "docker:updater:git-sync-skipped",
                    "error",
                    details
                );
            }
            const failed = steps.filter(
                (step) => !step.isOk && !isNonblockingRegistrationFailure(step)
            );
            if (failed.length > 0) {
                throw new ScheduledJobActionError(
                    failed.map((step) => `${step.step}: ${step.stderr}`).join("\n"),
                    { serviceId, steps }
                );
            }
            return { serviceId, steps };
        },
        { timeoutMs: 30 * 60 * 1000 }
    );
    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction("docker.updater", [job.id]);
        const existing = getScheduledJob(job.id);
        upsertScheduledJob({
            ...job,
            enabled: existing?.enabled ?? true,
            scheduleType: existing?.scheduleType ?? job.scheduleType,
            intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
            timeOfDay: existing ? existing.timeOfDay : job.timeOfDay,
            cronExpression: existing ? existing.cronExpression : undefined,
        });
        database.run("COMMIT");
    } catch (error) {
        database.run("ROLLBACK");
        throw error;
    }
}
