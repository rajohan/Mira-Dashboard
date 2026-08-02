import { enqueueJobExecution } from "../../services/jobExecutionQueue/repository.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "../../services/queuedJobExecution.ts";
import { invalidateDockerReadSnapshots } from "./snapshots.ts";

export async function runQueuedDockerAction(options: {
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

export async function waitForDockerMutationExecution(
    executionId: string,
    timeoutMs: number
) {
    try {
        return await waitForJobExecution(executionId, { timeoutMs });
    } finally {
        invalidateDockerReadSnapshots();
    }
}

export function outputString(output: Record<string, unknown>, key: string): string {
    return typeof output[key] === "string" ? output[key] : "";
}

export function outputNumber(
    output: Record<string, unknown>,
    key: string
): number | undefined {
    return typeof output[key] === "number" && Number.isFinite(output[key])
        ? output[key]
        : undefined;
}
