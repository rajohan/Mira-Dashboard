import { syncDockerUpdaterChanges } from "../gitHygiene.ts";
import { caughtMessage } from "./support.ts";
import type { DockerUpdaterStepResult } from "./types.ts";

export async function syncDockerUpdaterChangesBestEffort(
    steps: DockerUpdaterStepResult[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<void> {
    const updateSteps = steps.filter((step) => step.step.includes("-update:"));
    if (updateSteps.length === 0) {
        try {
            const pendingResult = await syncDockerUpdaterChanges(
                [],
                signal,
                protectFromCancellation
            );
            if (pendingResult.pushed) {
                steps.push({
                    step: "git-sync:docker",
                    isOk: true,
                    stdout: JSON.stringify(pendingResult),
                    stderr: "",
                });
            }
        } catch (error) {
            signal?.throwIfAborted();
            steps.push({
                step: "git-sync:docker",
                isOk: false,
                stdout: "",
                stderr: caughtMessage(error),
            });
        }
        return;
    }
    const changedPaths = updateSteps.flatMap((step) => step.changedPaths ?? []);
    if (changedPaths.length === 0) {
        try {
            const pendingResult = await syncDockerUpdaterChanges(
                [],
                signal,
                protectFromCancellation
            );
            steps.push({
                step: "git-sync:docker",
                isOk: true,
                stdout: JSON.stringify(
                    pendingResult.pushed
                        ? pendingResult
                        : {
                              changedPaths: [],
                              pushed: false,
                              skippedReason: "no updated compose paths",
                          }
                ),
                stderr: "",
            });
        } catch (error) {
            signal?.throwIfAborted();
            steps.push({
                step: "git-sync:docker",
                isOk: false,
                stdout: "",
                stderr: caughtMessage(error),
            });
        }
        return;
    }
    try {
        const result = await syncDockerUpdaterChanges(
            changedPaths,
            signal,
            protectFromCancellation
        );
        steps.push({
            step: "git-sync:docker",
            isOk: true,
            stdout: JSON.stringify(result),
            stderr: "",
        });
    } catch (error) {
        signal?.throwIfAborted();
        steps.push({
            step: "git-sync:docker",
            isOk: false,
            stdout: "",
            stderr: caughtMessage(error),
        });
    }
}
