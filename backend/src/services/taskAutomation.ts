import { TASK_ASSIGNEES, type TaskAssigneeId } from "../constants/taskActors.ts";
import { database } from "../database.ts";
import gateway from "../gateway.ts";
import { HttpError } from "../http.ts";
import { errorMessage } from "../lib/errors.ts";

export type CronDisableIntent =
    | { mode: "indefinite"; comment: string }
    | { mode: "until"; comment: string; until: string };

export interface CronTaskLink {
    number: number;
    title: string;
    disableIntent?: CronDisableIntent;
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
    disableIntent?: CronDisableIntent;
    enabled?: boolean;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    missing?: boolean;
    nextRunAtMs?: number;
    recurring: boolean;
    runningAtMs?: number;
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
    enabled?: boolean;
    id: string;
    lastDurationMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    name?: string;
    nextRunAtMs?: number;
    runningAtMs?: number;
    taskNumbers: number[];
}

export interface HeartbeatAutomationSnapshot {
    isCronDataAvailable: boolean;
    cronError?: string;
    cronJobs: HeartbeatCronJob[];
    tasks: HeartbeatTask[];
}

const disableIntentCommentMaxLength = 1000;

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

/** Validates and normalizes an intentional cron disable annotation. */
export function normalizeCronDisableIntent(
    value: unknown
): CronDisableIntent | undefined {
    if (value === undefined || value === null) return;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError("disableIntent must be an object", 400);
    }

    const input = value as Record<string, unknown>;
    if (input.mode !== "until" && input.mode !== "indefinite") {
        throw new HttpError("disableIntent.mode must be until or indefinite", 400);
    }
    if (typeof input.comment !== "string" || !input.comment.trim()) {
        throw new HttpError("disableIntent.comment is required", 400);
    }
    const comment = input.comment.trim();
    if (comment.length > disableIntentCommentMaxLength) {
        throw new HttpError(
            `disableIntent.comment must be at most ${disableIntentCommentMaxLength} characters`,
            400
        );
    }
    if (input.mode === "indefinite") {
        return { mode: "indefinite", comment };
    }
    if (typeof input.until !== "string" || !input.until.trim()) {
        throw new HttpError("disableIntent.until is required for until mode", 400);
    }
    const untilTimestamp = Date.parse(input.until);
    if (Number.isNaN(untilTimestamp)) {
        throw new HttpError("disableIntent.until must be a valid timestamp", 400);
    }
    return {
        mode: "until",
        comment,
        until: new Date(untilTimestamp).toISOString(),
    };
}

/** Reads stored intent defensively without turning malformed legacy data into API errors. */
export function readCronDisableIntent(value: unknown): CronDisableIntent | undefined {
    try {
        return normalizeCronDisableIntent(value);
    } catch {
        return;
    }
}

/** Ensures a newly submitted time-bounded disable has not already expired. */
export function assertCronDisableIntentIsCurrent(intent: CronDisableIntent): void {
    if (intent.mode === "until" && Date.parse(intent.until) <= Date.now()) {
        throw new HttpError("disableIntent.until must be in the future", 400);
    }
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
            disableIntent: readCronDisableIntent(stored.disableIntent),
        });
        links.set(id, taskLinks);
    }
    return links;
}

/** Adds task-link metadata to raw OpenClaw cron jobs for the Jobs UI. */
export function withCronTaskLinks<T extends CronJob>(
    jobs: T[]
): Array<T & { taskLinks?: CronTaskLink[] }> {
    const linksByJobId = cronTaskLinksByJobId();
    return jobs.map((job) => {
        const taskLinks = linksByJobId.get(cronJobId(job));
        return taskLinks && taskLinks.length > 0 ? { ...job, taskLinks } : job;
    });
}

/** Stores or clears intentional-disable metadata on open tasks linked to a cron job. */
export function updateCronTaskDisableIntent(
    id: string,
    intent: CronDisableIntent | undefined
): number {
    const timestamp = new Date().toISOString();
    const updates = openTaskAutomationRows()
        .map((task) => ({
            task,
            automation: parseRecordJson(task.automation_json),
        }))
        .filter(({ automation }) => stringFromRecord(automation, "cronJobId") === id);

    database.transaction(() => {
        for (const { task, automation } of updates) {
            if (intent) automation.disableIntent = intent;
            else delete automation.disableIntent;
            database
                .prepare(
                    "UPDATE tasks SET automation_json = ?, updated_at = ? WHERE id = ?"
                )
                .run(JSON.stringify(automation), timestamp, task.id);
        }
    })();
    return updates.length;
}

function isHeartbeatRelevantTask(
    task: TaskAutomationRow,
    hasRecurringAutomation: boolean
): boolean {
    if (hasRecurringAutomation) return true;
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

    const taskRows = openTaskAutomationRows();
    const taskNumbersByCronJobId = new Map<string, number[]>();
    for (const task of taskRows) {
        const id = stringFromRecord(parseRecordJson(task.automation_json), "cronJobId");
        if (!id) continue;
        taskNumbersByCronJobId.set(id, [
            ...(taskNumbersByCronJobId.get(id) ?? []),
            task.id,
        ]);
    }
    const heartbeatCronJobs = cronJobs
        .map((job): HeartbeatCronJob | undefined => {
            const id = cronJobId(job);
            if (!id) return;
            const state = job.state;
            return {
                id,
                name: job.name,
                enabled: job.enabled,
                runningAtMs: numberFromRecord(state, "runningAtMs"),
                nextRunAtMs: numberFromRecord(state, "nextRunAtMs"),
                lastRunAtMs: numberFromRecord(state, "lastRunAtMs"),
                lastRunStatus:
                    stringFromRecord(state, "lastRunStatus") ||
                    stringFromRecord(state, "lastStatus"),
                lastDurationMs: numberFromRecord(state, "lastDurationMs"),
                taskNumbers: taskNumbersByCronJobId.get(id) ?? [],
            };
        })
        .filter((job): job is HeartbeatCronJob => job !== undefined);

    const tasks = taskRows
        .map((task): HeartbeatTask | undefined => {
            const stored = parseRecordJson(task.automation_json);
            const id = stringFromRecord(stored, "cronJobId");
            if (!isHeartbeatRelevantTask(task, Boolean(id))) return;
            const job = id ? cronJobsById.get(id) : undefined;
            const state = job?.state;
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
                          enabled: job?.enabled,
                          missing: isCronDataAvailable ? !job : undefined,
                          runningAtMs: numberFromRecord(state, "runningAtMs"),
                          nextRunAtMs: numberFromRecord(state, "nextRunAtMs"),
                          lastRunAtMs: numberFromRecord(state, "lastRunAtMs"),
                          lastRunStatus:
                              stringFromRecord(state, "lastRunStatus") ||
                              stringFromRecord(state, "lastStatus"),
                          disableIntent: readCronDisableIntent(stored.disableIntent),
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
