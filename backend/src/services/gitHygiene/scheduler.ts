import { database } from "../../database/connection.ts";
import { registerScheduledJobAction } from "../scheduledJobs/actionRegistry.ts";
import {
    getScheduledJob,
    removeScheduledJobsNotInAction,
    upsertScheduledJob,
} from "../scheduledJobs/repository.ts";
import { syncOpenClawWorkspaceSafePaths } from "./workspaceSync.ts";

const WORKSPACE_SYNC_JOB_ID = "git.openclaw.workspace-sync";
const GIT_WORKSPACE_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

export function registerGitHygieneScheduledJobs(): void {
    const job = {
        id: WORKSPACE_SYNC_JOB_ID,
        name: "OpenClaw workspace sync",
        description: "Commit and push safe generated OpenClaw workspace state.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "05:20",
        actionKey: "git.openclaw.workspace-sync",
        actionPayload: {},
        resourceClass: "host-heavy",
    } as const;
    registerScheduledJobAction(
        "git.openclaw.workspace-sync",
        async (_job, signal, context) => {
            const result = await syncOpenClawWorkspaceSafePaths(
                signal,
                context.protectFromCancellation
            );
            return { ...result };
        },
        { timeoutMs: GIT_WORKSPACE_SYNC_TIMEOUT_MS }
    );
    database.run("BEGIN IMMEDIATE");
    try {
        removeScheduledJobsNotInAction("git.openclaw.workspace-sync", [job.id]);
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
