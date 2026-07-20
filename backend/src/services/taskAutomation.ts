import { TASK_ASSIGNEES, type TaskAssigneeId } from "../constants/taskActors.ts";
import { database } from "../database.ts";
import gateway from "../gateway.ts";
import { errorMessage } from "../lib/errors.ts";
import type { JobDisableIntent } from "./jobDisableIntent.ts";
import { openClawCronDisableIntentsByJobId } from "./openClawCronMetadata.ts";

export interface CronTaskLink {
    number: number;
    title: string;
}

interface TaskAutomationRow {
    id: number;
    title: string;
    status: "blocked" | "done" | "in-progress" | "todo";
    priority: "high" | "low" | "medium";
    assignee: TaskAssigneeId | null | undefined;
    automation_json: string;
}

interface CronJob {
    enabled?: boolean;
    id?: string;
    jobId?: string;
    name?: string;
    state?: Record<string, unknown>;
    [key: string]: unknown;
}

interface CronListResponse {
    items?: CronJob[];
    jobs?: CronJob[];
}

interface HeartbeatTaskAutomation {
    cronJobId: string;
    missing?: boolean;
    recurring: boolean;
}

interface HeartbeatTask {
    assignee?: TaskAssigneeId;
    automation?: HeartbeatTaskAutomation;
    number: number;
    priority: TaskAutomationRow["priority"];
    status: TaskAutomationRow["status"];
    title: string;
}

interface HeartbeatCronJob {
    disableIntent?: JobDisableIntent;
    enabled?: boolean;
    id: string;
    lastDurationMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    name?: string;
    nextRunAtMs?: number;
    runningAtMs?: number;
}

export interface HeartbeatAutomationSnapshot {
    isCronDataAvailable: boolean;
    cronError?: string;
    cronJobs: HeartbeatCronJob[];
    tasks: HeartbeatTask[];
}

function parseRecordJson(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

function stringFromRecord(
    record: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const value = record?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromRecord(
    record: Record<string, unknown> | undefined,
    key: string
): number | undefined {
    const value = record?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanFromRecord(
    record: Record<string, unknown> | undefined,
    key: string
): boolean | undefined {
    const value = record?.[key];
    return typeof value === "boolean" ? value : undefined;
}

function cronJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

function normalizedCronJobs(payload: unknown): CronJob[] {
    if (!payload || typeof payload !== "object") return [];
    const value = payload as CronListResponse;
    if (Array.isArray(value.jobs)) return value.jobs;
    return Array.isArray(value.items) ? value.items : [];
}

function openTaskAutomationRows(): TaskAutomationRow[] {
    return database
        .prepare(
            `SELECT id, title, status, priority, assignee, automation_json
             FROM tasks
             WHERE status != 'done'
             ORDER BY id`
        )
        .all() as unknown as TaskAutomationRow[];
}

/** Returns open task links for each OpenClaw cron job. */
export function cronTaskLinksByJobId(): Map<string, CronTaskLink[]> {
    const links = new Map<string, CronTaskLink[]>();
    for (const task of openTaskAutomationRows()) {
        const stored = parseRecordJson(task.automation_json);
        const id = stringFromRecord(stored, "cronJobId");
        if (!id) continue;
        const taskLinks = links.get(id) ?? [];
        taskLinks.push({
            number: task.id,
            title: task.title,
        });
        links.set(id, taskLinks);
    }
    return links;
}

/** Adds Dashboard-owned metadata to raw OpenClaw cron jobs for the Jobs UI. */
export function withCronTaskLinks<T extends CronJob>(
    jobs: T[]
): Array<T & { disableIntent?: JobDisableIntent; taskLinks?: CronTaskLink[] }> {
    const linksByJobId = cronTaskLinksByJobId();
    const disableIntentsByJobId = openClawCronDisableIntentsByJobId();
    return jobs.map((job) => {
        const id = cronJobId(job);
        const disableIntent = disableIntentsByJobId.get(id);
        const taskLinks = linksByJobId.get(id);
        return {
            ...job,
            ...(disableIntent && { disableIntent }),
            ...(taskLinks && taskLinks.length > 0 && { taskLinks }),
        };
    });
}

function isHeartbeatRelevantTask(
    task: TaskAutomationRow,
    hasCronAutomation: boolean
): boolean {
    if (hasCronAutomation) return true;
    if (
        task.assignee === TASK_ASSIGNEES.mira.id &&
        (task.priority === "high" || task.priority === "medium")
    ) {
        return true;
    }
    return task.assignee === TASK_ASSIGNEES.raymond.id && task.status === "blocked";
}

/** Builds the compact open-task projection consumed by OpenClaw heartbeat. */
export async function getHeartbeatAutomationSnapshot(): Promise<HeartbeatAutomationSnapshot> {
    let isCronDataAvailable = true;
    let cronError: string | undefined;
    let cronJobs: CronJob[] = [];
    try {
        cronJobs = normalizedCronJobs(
            await gateway.request("cron.list", { includeDisabled: true })
        );
    } catch (error) {
        isCronDataAvailable = false;
        cronError = errorMessage(error, "OpenClaw cron list unavailable");
    }
    const cronJobsById = new Map(
        cronJobs
            .map((job) => [cronJobId(job), job] as const)
            .filter(([id]) => id.length > 0)
    );
    const disableIntentsByJobId = openClawCronDisableIntentsByJobId();

    const taskRows = openTaskAutomationRows();
    const heartbeatCronJobs = cronJobs
        .map((job): HeartbeatCronJob | undefined => {
            const id = cronJobId(job);
            if (!id) return;
            const state = job.state;
            return {
                id,
                name: job.name,
                disableIntent: disableIntentsByJobId.get(id),
                enabled: job.enabled,
                runningAtMs: numberFromRecord(state, "runningAtMs"),
                nextRunAtMs: numberFromRecord(state, "nextRunAtMs"),
                lastRunAtMs: numberFromRecord(state, "lastRunAtMs"),
                lastRunStatus:
                    stringFromRecord(state, "lastRunStatus") ||
                    stringFromRecord(state, "lastStatus"),
                lastDurationMs: numberFromRecord(state, "lastDurationMs"),
            };
        })
        .filter((job): job is HeartbeatCronJob => job !== undefined);

    const tasks = taskRows
        .map((task): HeartbeatTask | undefined => {
            const stored = parseRecordJson(task.automation_json);
            const id = stringFromRecord(stored, "cronJobId");
            if (!isHeartbeatRelevantTask(task, Boolean(id))) return;
            return {
                number: task.id,
                title: task.title,
                status: task.status,
                priority: task.priority,
                assignee: task.assignee ?? undefined,
                automation: id
                    ? {
                          cronJobId: id,
                          recurring: booleanFromRecord(stored, "recurring") ?? true,
                          missing: isCronDataAvailable
                              ? !cronJobsById.has(id)
                              : undefined,
                      }
                    : undefined,
            };
        })
        .filter((task): task is HeartbeatTask => task !== undefined);

    return {
        isCronDataAvailable,
        cronError,
        cronJobs: heartbeatCronJobs,
        tasks,
    };
}
