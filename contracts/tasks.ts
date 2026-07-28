import {
    assertContractKeys,
    contractEnum,
    contractFiniteNumber,
    contractPositiveInteger,
    contractRecord,
    contractString,
    invalidContract,
    optionalContractBoolean,
    optionalContractString,
    optionalContractStringArray,
    requiresContractBoolean,
} from "./runtime";

export const TASK_ASSIGNEES = {
    mira: {
        id: "mira-2026",
        label: "Mira",
        githubUrl: "https://github.com/mira-2026",
    },
    raymond: {
        id: "rajohan",
        label: "Raymond",
        githubUrl: "https://github.com/rajohan",
    },
} as const;

export type TaskAssigneeId = (typeof TASK_ASSIGNEES)[keyof typeof TASK_ASSIGNEES]["id"];

export const TASK_ASSIGNEE_IDS = [
    TASK_ASSIGNEES.mira.id,
    TASK_ASSIGNEES.raymond.id,
] as const;

export interface TaskAutomation {
    cronJobId: string;
    enabled?: boolean;
    jobName?: string;
    lastDurationMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    model?: string;
    nextRunAtMs?: number;
    recurring: boolean;
    runningAtMs?: number;
    schedule?: { kind?: string; [key: string]: unknown };
    scheduleSummary?: string;
    sessionTarget?: string;
    source?: "cron" | "stored";
    thinking?: string;
    type: "cron";
}

export interface TaskAutomationInput {
    cronJobId: string;
    model?: string;
    recurring?: boolean;
    scheduleSummary?: string;
    sessionTarget?: string;
    thinking?: string;
    type?: "cron";
}

export interface Task {
    assignees: Array<{
        avatar_url?: string;
        login?: string;
        name?: string;
    }>;
    automation?: TaskAutomation;
    body?: string;
    createdAt: string;
    labels: Array<{ color?: string; name: string }>;
    number: number;
    state: string;
    title: string;
    updatedAt: string;
    url: string;
}

export interface TaskUpdate {
    author: TaskAssigneeId;
    createdAt: string;
    id: number;
    messageMd: string;
    taskId: number;
}

export type ColumnId = "todo" | "in-progress" | "blocked" | "done";

export interface CreateTaskRequest {
    assignee?: TaskAssigneeId | null;
    automation?: TaskAutomationInput;
    body?: string;
    labels?: string[];
    title: string;
}

export interface UpdateTaskRequest {
    automation?: TaskAutomationInput | null;
    body?: string;
    labels?: string[];
    title?: string;
}

export interface AssignTaskRequest {
    assignee?: TaskAssigneeId | null;
}

export interface MoveTaskRequest {
    columnLabel: ColumnId;
}

export interface CreateTaskUpdateRequest {
    author: TaskAssigneeId;
    messageMd: string;
}

export interface UpdateTaskUpdateRequest {
    messageMd: string;
}

export interface TaskMutationResponse {
    isOk: true;
}

const TASK_COLUMNS = ["todo", "in-progress", "blocked", "done"] as const;
const TASK_AUTOMATION_KEYS = [
    "cronJobId",
    "model",
    "recurring",
    "scheduleSummary",
    "sessionTarget",
    "thinking",
    "type",
] as const;

function parseTaskAssignee(value: unknown, path: string): TaskAssigneeId | undefined {
    return value === undefined ? undefined : contractEnum(value, TASK_ASSIGNEE_IDS, path);
}

/** Parses the reusable task-automation request fragment. */
export function parseTaskAutomationInput(
    value: unknown,
    path = "body.automation"
): TaskAutomationInput {
    const input = contractRecord(value, path);
    assertContractKeys(input, TASK_AUTOMATION_KEYS, path);
    const model = optionalContractString(input.model, `${path}.model`, {
        allowEmpty: true,
    });
    const scheduleSummary = optionalContractString(
        input.scheduleSummary,
        `${path}.scheduleSummary`,
        { allowEmpty: true }
    );
    const sessionTarget = optionalContractString(
        input.sessionTarget,
        `${path}.sessionTarget`,
        { allowEmpty: true }
    );
    const thinking = optionalContractString(input.thinking, `${path}.thinking`, {
        allowEmpty: true,
    });
    const type =
        input.type === undefined
            ? undefined
            : contractEnum(input.type, ["cron"] as const, `${path}.type`);
    return {
        cronJobId: contractString(input.cronJobId, `${path}.cronJobId`),
        ...(type !== undefined && { type }),
        ...(optionalContractBoolean(input.recurring, `${path}.recurring`) !==
            undefined && {
            recurring: requiresContractBoolean(input.recurring, `${path}.recurring`),
        }),
        ...(scheduleSummary && { scheduleSummary }),
        ...(sessionTarget && { sessionTarget }),
        ...(model && { model }),
        ...(thinking && { thinking }),
    };
}

/** Parses task creation at the backend HTTP trust boundary. */
export function parseCreateTaskRequest(value: unknown): CreateTaskRequest {
    const input = contractRecord(value);
    assertContractKeys(
        input,
        ["assignee", "automation", "body", "labels", "title"],
        "body"
    );
    const assignee =
        input.assignee === null
            ? input.assignee
            : parseTaskAssignee(input.assignee, "body.assignee");
    const automation =
        input.automation === undefined
            ? undefined
            : parseTaskAutomationInput(input.automation);
    return {
        title: contractString(input.title, "body.title"),
        ...(assignee !== undefined && { assignee }),
        ...(automation !== undefined && { automation }),
        ...(optionalContractString(input.body, "body.body", {
            allowEmpty: true,
            trim: false,
        }) !== undefined && {
            body: contractString(input.body, "body.body", {
                allowEmpty: true,
                trim: false,
            }),
        }),
        ...(optionalContractStringArray(input.labels, "body.labels") !== undefined && {
            labels: optionalContractStringArray(input.labels, "body.labels"),
        }),
    };
}

/** Parses a task patch without accepting unknown or mistyped fields. */
export function parseUpdateTaskRequest(value: unknown): UpdateTaskRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["automation", "body", "labels", "title"], "body");
    const automation =
        input.automation === undefined || input.automation === null
            ? input.automation
            : parseTaskAutomationInput(input.automation);
    const body = optionalContractString(input.body, "body.body", {
        allowEmpty: true,
        trim: false,
    });
    const labels = optionalContractStringArray(input.labels, "body.labels");
    const title = optionalContractString(input.title, "body.title");
    return {
        ...(automation !== undefined && { automation }),
        ...(body !== undefined && { body }),
        ...(labels !== undefined && { labels }),
        ...(title !== undefined && { title }),
    };
}

export function parseAssignTaskRequest(value: unknown): AssignTaskRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["assignee"], "body");
    if (input.assignee === null) return { assignee: input.assignee };
    const assignee = parseTaskAssignee(input.assignee, "body.assignee");
    return assignee === undefined ? {} : { assignee };
}

export function parseMoveTaskRequest(value: unknown): MoveTaskRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["columnLabel"], "body");
    return {
        columnLabel: contractEnum(input.columnLabel, TASK_COLUMNS, "body.columnLabel"),
    };
}

export function parseCreateTaskUpdateRequest(value: unknown): CreateTaskUpdateRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["author", "messageMd"], "body");
    return {
        author: contractEnum(input.author, TASK_ASSIGNEE_IDS, "body.author"),
        messageMd: contractString(input.messageMd, "body.messageMd", {
            trim: false,
        }),
    };
}

export function parseUpdateTaskUpdateRequest(value: unknown): UpdateTaskUpdateRequest {
    const input = contractRecord(value);
    assertContractKeys(input, ["messageMd"], "body");
    return {
        messageMd: contractString(input.messageMd, "body.messageMd", {
            trim: false,
        }),
    };
}

function parseTaskAutomation(value: unknown, path: string): TaskAutomation {
    const input = contractRecord(value, path);
    const cronJobId = contractString(input.cronJobId, `${path}.cronJobId`);
    const recurring = requiresContractBoolean(input.recurring, `${path}.recurring`);
    const type = contractEnum(input.type, ["cron"] as const, `${path}.type`);
    return {
        cronJobId,
        recurring,
        type,
        ...(optionalContractBoolean(input.enabled, `${path}.enabled`) !== undefined && {
            enabled: requiresContractBoolean(input.enabled, `${path}.enabled`),
        }),
        ...Object.fromEntries(
            [
                "jobName",
                "lastRunStatus",
                "model",
                "scheduleSummary",
                "sessionTarget",
                "thinking",
            ].flatMap((key) => {
                const parsed = optionalContractString(input[key], `${path}.${key}`, {
                    allowEmpty: true,
                    trim: false,
                });
                return parsed === undefined ? [] : [[key, parsed]];
            })
        ),
        ...Object.fromEntries(
            ["lastDurationMs", "lastRunAtMs", "nextRunAtMs", "runningAtMs"].flatMap(
                (key) => {
                    const candidate = input[key];
                    return candidate === undefined
                        ? []
                        : [[key, contractFiniteNumber(candidate, `${path}.${key}`)]];
                }
            )
        ),
        ...(input.schedule !== undefined && {
            schedule: contractRecord(input.schedule, `${path}.schedule`),
        }),
        ...(input.source !== undefined && {
            source: contractEnum(
                input.source,
                ["cron", "stored"] as const,
                `${path}.source`
            ),
        }),
    } as TaskAutomation;
}

/** Parses one task response before frontend state accepts it. */
export function parseTaskResponse(value: unknown, path = "response"): Task {
    const input = contractRecord(value, path);
    const assignees = Array.isArray(input.assignees)
        ? input.assignees.map((assignee, index) => {
              const entry = contractRecord(assignee, `${path}.assignees[${index}]`);
              return {
                  ...(optionalContractString(
                      entry.avatar_url,
                      `${path}.assignees[${index}].avatar_url`,
                      { allowEmpty: true, trim: false }
                  ) !== undefined && {
                      avatar_url: entry.avatar_url as string,
                  }),
                  ...(optionalContractString(
                      entry.login,
                      `${path}.assignees[${index}].login`,
                      { allowEmpty: true, trim: false }
                  ) !== undefined && { login: entry.login as string }),
                  ...(optionalContractString(
                      entry.name,
                      `${path}.assignees[${index}].name`,
                      { allowEmpty: true, trim: false }
                  ) !== undefined && { name: entry.name as string }),
              };
          })
        : invalidContract(`${path}.assignees`, "must be an array");
    const labels = Array.isArray(input.labels)
        ? input.labels.map((label, index) => {
              const entry = contractRecord(label, `${path}.labels[${index}]`);
              return {
                  name: contractString(entry.name, `${path}.labels[${index}].name`, {
                      allowEmpty: true,
                      trim: false,
                  }),
                  ...(optionalContractString(
                      entry.color,
                      `${path}.labels[${index}].color`,
                      { allowEmpty: true, trim: false }
                  ) !== undefined && { color: entry.color as string }),
              };
          })
        : invalidContract(`${path}.labels`, "must be an array");
    return {
        assignees,
        createdAt: contractString(input.createdAt, `${path}.createdAt`, {
            trim: false,
        }),
        labels,
        number: contractPositiveInteger(input.number, `${path}.number`),
        state: contractString(input.state, `${path}.state`),
        title: contractString(input.title, `${path}.title`, {
            allowEmpty: true,
            trim: false,
        }),
        updatedAt: contractString(input.updatedAt, `${path}.updatedAt`, {
            trim: false,
        }),
        url: contractString(input.url, `${path}.url`, {
            allowEmpty: true,
            trim: false,
        }),
        ...(optionalContractString(input.body, `${path}.body`, {
            allowEmpty: true,
            trim: false,
        }) !== undefined && { body: input.body as string }),
        ...(input.automation !== undefined && {
            automation: parseTaskAutomation(input.automation, `${path}.automation`),
        }),
    };
}

export function parseTasksResponse(value: unknown): Task[] {
    if (!Array.isArray(value)) {
        return invalidContract("response", "must be an array");
    }
    return value.map((task, index) => parseTaskResponse(task, `response[${index}]`));
}

export function parseTaskUpdateResponse(value: unknown, path = "response"): TaskUpdate {
    const input = contractRecord(value, path);
    return {
        author: contractEnum(input.author, TASK_ASSIGNEE_IDS, `${path}.author`),
        createdAt: contractString(input.createdAt, `${path}.createdAt`, {
            trim: false,
        }),
        id: contractPositiveInteger(input.id, `${path}.id`),
        messageMd: contractString(input.messageMd, `${path}.messageMd`, {
            trim: false,
        }),
        taskId: contractPositiveInteger(input.taskId, `${path}.taskId`),
    };
}

export function parseTaskUpdatesResponse(value: unknown): TaskUpdate[] {
    if (!Array.isArray(value)) {
        return invalidContract("response", "must be an array");
    }
    return value.map((update, index) =>
        parseTaskUpdateResponse(update, `response[${index}]`)
    );
}

export function parseTaskMutationResponse(value: unknown): TaskMutationResponse {
    const input = contractRecord(value, "response");
    return {
        isOk:
            input.isOk === true ? true : invalidContract("response.isOk", "must be true"),
    };
}
