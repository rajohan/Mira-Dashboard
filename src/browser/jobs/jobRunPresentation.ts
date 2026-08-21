import type { JobRunState } from "../../contracts/jobModel.ts";

/** @returns Human-readable durable run state text. */
export function jobRunStateLabel(state: JobRunState): string {
    return state.replaceAll("-", " ");
}

/** @returns Shared semantic badge treatment for a durable run state. */
export function jobRunStateBadgeVariant(
    state: JobRunState
): "danger" | "default" | "info" | "success" | "warning" {
    switch (state) {
        case "cancelled": {
            return "default";
        }
        case "failed":
        case "timed-out": {
            return "danger";
        }
        case "queued": {
            return "info";
        }
        case "running": {
            return "warning";
        }
        case "succeeded": {
            return "success";
        }
    }
}
