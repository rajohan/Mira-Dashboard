import {
    taskAssigneeIds,
    type TaskPriority,
    type TaskStatus,
} from "../../../contracts/taskModel.ts";

/** Product policy selecting priority work assigned to the Dashboard agent. */
export const taskHeartbeatAgentAssignee =
    "mira-2026" as const satisfies (typeof taskAssigneeIds)[number];
export const taskHeartbeatAgentPriorities = [
    "medium",
    "high",
] as const satisfies readonly TaskPriority[];
export const taskHeartbeatAgentStatus = "blocked" as const satisfies TaskStatus;

/** Product policy selecting owner-blocked work that needs operator attention. */
export const taskHeartbeatOwnerAssignee =
    "rajohan" as const satisfies (typeof taskAssigneeIds)[number];
export const taskHeartbeatOwnerStatus = "blocked" as const satisfies TaskStatus;
