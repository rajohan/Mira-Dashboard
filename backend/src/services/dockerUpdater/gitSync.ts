import { syncDockerUpdaterChanges } from "../gitHygiene.ts";
import { caughtMessage } from "./support.ts";
import type { DockerUpdaterStepResult } from "./types.ts";

async function appendSyncStep(
    steps: DockerUpdaterStepResult[],
    changedPaths: string[],
    signal: AbortSignal | undefined,
    protectFromCancellation: (() => void) | undefined,
    options: {
        recordUnpushed: boolean;
        unpushedPayload?: Record<string, unknown>;
    }
): Promise<void> {
    try {
        const result = await syncDockerUpdaterChanges(
            changedPaths,
            signal,
            protectFromCancellation
        );
        if (!result.pushed && !options.recordUnpushed) {
            return;
        }
        steps.push({
            kind: "git-sync",
            step: "git-sync:docker",
            isOk: true,
            stdout: JSON.stringify(
                !result.pushed && options.unpushedPayload
                    ? options.unpushedPayload
                    : result
            ),
            stderr: "",
        });
    } catch (error) {
        signal?.throwIfAborted();
        steps.push({
            kind: "git-sync",
            step: "git-sync:docker",
            isOk: false,
            stdout: "",
            stderr: caughtMessage(error),
        });
    }
}

export async function syncDockerUpdaterChangesBestEffort(
    steps: DockerUpdaterStepResult[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<void> {
    const updateSteps = steps.filter((step) => step.kind === "update");
    if (updateSteps.length === 0) {
        await appendSyncStep(steps, [], signal, protectFromCancellation, {
            recordUnpushed: false,
        });
        return;
    }
    const changedPaths = updateSteps.flatMap((step) => step.changedPaths ?? []);
    if (changedPaths.length === 0) {
        await appendSyncStep(steps, [], signal, protectFromCancellation, {
            recordUnpushed: true,
            unpushedPayload: {
                changedPaths: [],
                pushed: false,
                skippedReason: "no updated compose paths",
            },
        });
        return;
    }
    await appendSyncStep(steps, changedPaths, signal, protectFromCancellation, {
        recordUnpushed: true,
    });
}
