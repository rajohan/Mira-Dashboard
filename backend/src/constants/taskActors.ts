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
