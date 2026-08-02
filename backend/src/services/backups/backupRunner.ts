import type { BackupType } from "../../../../contracts/backups.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    spawnProcess,
} from "../../lib/processes.ts";
import {
    type ActiveBackupJob,
    backupJobs,
    backupRouteState,
    evictCompletedBackupJobs,
    getCurrentBackupJob,
    refreshBackupStatus,
    trimBackupOutput,
} from "./backupJobs.ts";
import {
    type BackupAbortConfig,
    terminateContainerProcessSafely,
    waitForContainerProcessExitWithRetries,
    waitForHostProcessExitWithRetries,
} from "./backupProcessControl.ts";

const BACKUP_ABORT_SIGKILL_GRACE_MS = 10_000;

export function startBackupJob(
    type: BackupType,
    command: string,
    signal?: AbortSignal,
    abortConfig?: BackupAbortConfig,
    hostAbortPattern?: string
) {
    const existingJob = getCurrentBackupJob(type);
    if (existingJob?.status === "running") {
        return existingJob;
    }
    if (existingJob?.status === "needs_attention") {
        throw Object.assign(new Error(`${type.toUpperCase()} backup needs attention`), {
            statusCode: 409,
        });
    }
    if (signal?.aborted) {
        throw new Error("Backup aborted by scheduler");
    }
    evictCompletedBackupJobs(type);

    const jobId = Bun.randomUUIDv7();
    const completed = Promise.withResolvers<ActiveBackupJob>();
    const job: ActiveBackupJob = {
        id: jobId,
        type,
        status: "running",
        code: undefined,
        stdout: "",
        stderr: "",
        startedAt: Date.now(),
        endedAt: undefined,
        completed: completed.promise,
    };

    backupJobs.set(jobId, job);
    if (type === "kopia") {
        backupRouteState.activeKopiaJobId = jobId;
    } else {
        backupRouteState.activeWalgJobId = jobId;
    }

    let child: BunProcess;
    try {
        child = spawnProcess("bash", ["-lc", command], {
            detached: true,
            env: process.env,
        });
    } catch (error) {
        backupJobs.delete(jobId);
        if (backupRouteState.activeKopiaJobId === jobId) {
            backupRouteState.activeKopiaJobId = undefined;
        }
        if (backupRouteState.activeWalgJobId === jobId) {
            backupRouteState.activeWalgJobId = undefined;
        }
        throw error;
    }

    job.process = child;
    let isFinalized = false;
    let isFinalizing = false;
    let isAbortRequested = false;
    let hostAbortKillTimer: NodeJS.Timeout | undefined;
    let containerAbortKillTimer: NodeJS.Timeout | undefined;

    const finalizeJob = async (code: number, signalName: NodeJS.Signals | undefined) => {
        if (isFinalized || isFinalizing) {
            return;
        }
        isFinalizing = true;
        const interrupted = isAbortRequested || signalName !== undefined;
        let isNeedsAttention = false;
        if (interrupted && abortConfig) {
            try {
                isNeedsAttention = !(await waitForContainerProcessExitWithRetries(
                    abortConfig,
                    job
                ));
            } catch (error) {
                isNeedsAttention = true;
                job.stderr = trimBackupOutput(
                    `${job.stderr}\n${errorMessage(error, "Failed to verify container backup process exit")}`.trim()
                );
            }
        }
        if (interrupted && hostAbortPattern) {
            try {
                isNeedsAttention ||= !(await waitForHostProcessExitWithRetries(
                    hostAbortPattern,
                    job
                ));
            } catch (error) {
                isNeedsAttention = true;
                job.stderr = trimBackupOutput(
                    `${job.stderr}\n${errorMessage(error, "Failed to verify host backup process exit")}`.trim()
                );
            }
        }
        if (hostAbortKillTimer) {
            clearTimeout(hostAbortKillTimer);
            hostAbortKillTimer = undefined;
        }
        if (containerAbortKillTimer) {
            clearTimeout(containerAbortKillTimer);
            containerAbortKillTimer = undefined;
        }
        const completedCode = interrupted ? 130 : code;
        job.status = isNeedsAttention ? "needs_attention" : "done";
        job.code = completedCode;
        job.endedAt = Date.now();
        isFinalized = true;
        signal?.removeEventListener("abort", abortBackup);
        completed.resolve(job);
        await refreshBackupStatus(type, job);
    };

    const markNeedsAttention = async () => {
        if (isFinalized || isFinalizing) {
            return;
        }
        isFinalizing = true;
        if (hostAbortKillTimer) {
            clearTimeout(hostAbortKillTimer);
            hostAbortKillTimer = undefined;
        }
        if (containerAbortKillTimer) {
            clearTimeout(containerAbortKillTimer);
            containerAbortKillTimer = undefined;
        }
        job.status = "needs_attention";
        job.code = 130;
        job.endedAt = Date.now();
        isFinalized = true;
        signal?.removeEventListener("abort", abortBackup);
        completed.resolve(job);
        await refreshBackupStatus(type, job);
    };

    const abortBackup = () => {
        if (isFinalized || isFinalizing || isAbortRequested) {
            return;
        }
        isAbortRequested = true;
        job.stderr = trimBackupOutput(
            `${job.stderr}\nBackup aborted by scheduler`.trim()
        );
        if (abortConfig) {
            void terminateContainerProcessSafely(abortConfig, "SIGTERM", job);
            containerAbortKillTimer = setTimeout(() => {
                void terminateContainerProcessSafely(abortConfig, "SIGKILL", job);
            }, BACKUP_ABORT_SIGKILL_GRACE_MS);
            containerAbortKillTimer.unref();
        }
        try {
            killProcessGroup(child, "SIGTERM");
            hostAbortKillTimer = setTimeout(() => {
                try {
                    killProcessGroup(child, "SIGKILL");
                } catch (error) {
                    job.stderr = trimBackupOutput(
                        `${job.stderr}\nFailed to force terminate backup process: ${errorMessage(
                            error,
                            "Unknown error"
                        )}`.trim()
                    );
                    void markNeedsAttention();
                }
            }, BACKUP_ABORT_SIGKILL_GRACE_MS);
            hostAbortKillTimer.unref();
        } catch (error) {
            job.stderr = trimBackupOutput(
                `${job.stderr}\nFailed to terminate backup process: ${errorMessage(
                    error,
                    "Unknown error"
                )}`.trim()
            );
            void markNeedsAttention();
        }
    };

    signal?.addEventListener("abort", abortBackup, { once: true });

    const stdoutDone = pipeProcessOutput(
        child.stdout as ReadableStream<Uint8Array> | undefined,
        (data) => {
            job.stdout = trimBackupOutput(job.stdout + String(data));
        }
    );

    const stderrDone = pipeProcessOutput(
        child.stderr as ReadableStream<Uint8Array> | undefined,
        (data) => {
            job.stderr = trimBackupOutput(job.stderr + String(data));
        }
    );

    void (async () => {
        try {
            const code = await child.exited;
            await Promise.all([stdoutDone, stderrDone]);
            await finalizeJob(code, isAbortRequested ? "SIGTERM" : undefined);
        } catch (error) {
            if (isFinalized || isFinalizing) {
                return;
            }
            isFinalizing = true;
            if (hostAbortKillTimer) {
                clearTimeout(hostAbortKillTimer);
                hostAbortKillTimer = undefined;
            }
            if (containerAbortKillTimer) {
                clearTimeout(containerAbortKillTimer);
                containerAbortKillTimer = undefined;
            }
            isFinalized = true;
            job.status = "done";
            job.code = 1;
            job.stderr = trimBackupOutput(
                `${job.stderr}\nBackup process failed: ${errorMessage(
                    error,
                    "Unknown error"
                )}`.trim()
            );
            job.endedAt = Date.now();
            if (signal) {
                signal.removeEventListener("abort", abortBackup);
            }
            completed.resolve(job);
            await refreshBackupStatus(type, job);
        }
    })();

    return job;
}
