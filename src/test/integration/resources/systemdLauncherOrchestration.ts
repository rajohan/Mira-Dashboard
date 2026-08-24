import {
    buildSystemdRunSubprocessSpecification,
    type SystemdLauncherCommand,
    type SystemdLauncherResult,
} from "./systemdLauncherCommand.ts";
import {
    classifySystemdLauncherTermination,
    createSystemdLauncherDeadline,
} from "./systemdLauncherDeadline.ts";
import {
    bestEffortSystemdPostMortem,
    ensureTransientUnitStopped,
    formatSystemdLauncherFailure,
    resetFailedTransientUnit,
} from "./systemdUnitControl.ts";

/**
 * Runs an evidence-producing child inside the reviewed transient cgroup.
 * @param command Sanitised systemd launcher command.
 * @returns Captured launcher output and exit status.
 * @throws {Error} When the launcher exceeds its deadline, is signal-terminated, or cleanup fails.
 */
export async function runSystemdEvidence(
    command: SystemdLauncherCommand
): Promise<SystemdLauncherResult> {
    const specification = buildSystemdRunSubprocessSpecification(command);
    const { timeout: deadlineMs, ...spawnOptions } = specification.options;
    let operationError: unknown;
    let result: SystemdLauncherResult | undefined;
    try {
        const deadline = createSystemdLauncherDeadline(deadlineMs);
        try {
            const process_ = Bun.spawn([...specification.argv], {
                ...spawnOptions,
                signal: deadline.signal,
            });
            const stderr = new Response(process_.stderr).text();
            const stdout = new Response(process_.stdout).text();
            const exitCode = await process_.exited;
            deadline.cancel();
            const [stderrText, stdoutText] = await Promise.all([stderr, stdout]);
            const termination = classifySystemdLauncherTermination(
                process_.signalCode,
                deadline.didFire(),
                spawnOptions.killSignal
            );
            if (termination?.kind === "deadline") {
                const diagnostic = await bestEffortSystemdPostMortem(command);
                throw new Error(
                    formatSystemdLauncherFailure(
                        `SSE memory evidence launcher exceeded its ${deadlineMs} ms outer deadline and was terminated by ${termination.signalCode}`,
                        stdoutText,
                        stderrText,
                        diagnostic
                    )
                );
            }
            if (termination !== undefined) {
                const diagnostic = await bestEffortSystemdPostMortem(command);
                throw new Error(
                    formatSystemdLauncherFailure(
                        `SSE memory evidence launcher was terminated by ${termination.signalCode} without the launcher-owned deadline signal; the output bound or an external signal may have stopped it`,
                        stdoutText,
                        stderrText,
                        diagnostic
                    )
                );
            }
            if (exitCode === 0) {
                result = {
                    exitCode,
                    stderr: stderrText,
                    stdout: stdoutText,
                };
            } else {
                const diagnostic = await bestEffortSystemdPostMortem(command);
                result = {
                    exitCode,
                    stderr: [stderrText.trim(), diagnostic]
                        .filter((value) => value.length > 0)
                        .join("\n"),
                    stdout: stdoutText,
                };
            }
        } finally {
            deadline.cancel();
        }
    } catch (error) {
        operationError = error;
    }

    let cleanupError: unknown;
    try {
        await ensureTransientUnitStopped(command);
    } catch (error) {
        cleanupError = error;
    }
    await resetFailedTransientUnit(command).catch(() => {});

    if (operationError !== undefined && cleanupError !== undefined) {
        throw new AggregateError(
            [operationError, cleanupError],
            "SSE memory evidence and transient-unit cleanup failed"
        );
    }
    if (operationError !== undefined) {
        throw operationError instanceof Error
            ? operationError
            : new Error("SSE memory evidence failed", { cause: operationError });
    }
    if (cleanupError !== undefined) {
        throw cleanupError instanceof Error
            ? cleanupError
            : new Error("Transient-unit cleanup failed", { cause: cleanupError });
    }
    if (result === undefined) {
        throw new Error("SSE memory evidence returned no launcher result");
    }
    return result;
}
