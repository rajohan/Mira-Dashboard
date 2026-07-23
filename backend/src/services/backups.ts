import { database } from "../database.ts";
import { errorMessage } from "../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../lib/processes.ts";
import { refreshCacheProducer } from "./cacheRefresh.ts";
import {
    enqueueJobExecution,
    getJobExecution,
    getLatestScheduledJobExecution,
    getPreviousScheduledJobExecution,
    type JobExecution,
} from "./jobExecutionQueue.ts";
import {
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "./queuedJobExecution.ts";
import {
    enqueueScheduledJob,
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    type ScheduledJobActionContext,
    ScheduledJobActionError,
    upsertScheduledJob,
} from "./scheduledJobs.ts";
const MAX_OUTPUT_CHARS = 100_000;
const SCHEDULED_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BACKUP_ABORT_SIGKILL_GRACE_MS = 10_000;
const KOPIA_BACKUP_SCRIPT_PATTERN = "/opt/docker/apps/kopia/backup.sh";
const WALG_BACKUP_SCRIPT_PATTERN = "/usr/local/bin/backup-push.sh";
const CONTAINER_PGREP_NO_MATCH_MARKER = "__MIRA_CONTAINER_PGREP_NO_MATCH__";
const backupAbortContainerWaitMs = 30_000;
const backupAbortContainerPollMs = 1000;
const backupAbortContainerConfirmAttempts = 3;
const backupAbortDockerExecTimeoutMs = 5000;

interface BackupAbortConfig {
    container: string;
    processPattern: string;
}

/** Represents backup job. */
interface BackupJob {
    id: string;
    type: "kopia" | "walg";
    status: "running" | "done" | "needs_attention";
    code: number | undefined;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | undefined;
    completed: Promise<BackupJob>;
    process?: BunProcess;
    statusRefreshed?: boolean;
}

const backupJobs = new Map<string, BackupJob>();
const backupRouteState: {
    activeKopiaJobId: string | undefined;
    activeWalgJobId: string | undefined;
} = {
    activeKopiaJobId: undefined,
    activeWalgJobId: undefined,
};

/** Performs trim output. */
function trimOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }
    return text.slice(-MAX_OUTPUT_CHARS);
}

/** Returns current job. */
function getCurrentJob(activeJobId: string | undefined, clear: () => void) {
    if (!activeJobId) {
        return;
    }
    const job = backupJobs.get(activeJobId) ?? undefined;
    if (!job) {
        clear();
        return;
    }

    if (job.status === "done") {
        clear();
    }

    return job;
}

/** Returns current kopia job. */
function getCurrentKopiaJob() {
    return getCurrentJob(backupRouteState.activeKopiaJobId, () => {
        backupRouteState.activeKopiaJobId = undefined;
    });
}

/** Returns current walg job. */
function getCurrentWalgJob() {
    return getCurrentJob(backupRouteState.activeWalgJobId, () => {
        backupRouteState.activeWalgJobId = undefined;
    });
}

/** Performs map job. */
export function mapBackupJob(job: BackupJob | undefined) {
    if (!job) {
        return;
    }

    return {
        id: job.id,
        type: job.type,
        status: job.status,
        code: job.code,
        stdout: job.stdout,
        stderr: job.stderr,
        startedAt: job.startedAt,
        endedAt: job.endedAt,
    };
}

/** Returns backup type from scheduled job payload. */
function getScheduledBackupType(payload: unknown) {
    if (typeof payload !== "object" || payload === null) {
        return;
    }

    return (payload as { type?: unknown }).type;
}

function backupStatusCacheKey(type: BackupJob["type"]) {
    return type === "kopia" ? "backup.kopia.status" : "backup.walg.status";
}

function evictCompletedBackupJobs(type: BackupJob["type"]) {
    for (const [id, job] of backupJobs) {
        if (job.type === type && job.status === "done") {
            backupJobs.delete(id);
        }
    }
}

export async function clearNeedsAttentionBackupJob(type: BackupJob["type"]) {
    const job = getCurrentBackupJob(type);
    if (!job || job.status === "done") {
        if (job) backupJobs.delete(job.id);
        throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
            statusCode: 404,
        });
    }
    if (job.status !== "needs_attention") {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup does not need attention`),
            { statusCode: 409 }
        );
    }
    backupJobs.delete(job.id);
    if (type === "kopia" && backupRouteState.activeKopiaJobId === job.id) {
        backupRouteState.activeKopiaJobId = undefined;
    }
    if (type === "walg" && backupRouteState.activeWalgJobId === job.id) {
        backupRouteState.activeWalgJobId = undefined;
    }
    await refreshBackupStatus(type, job);
    return job;
}

function recordBackupNeedsAttention(type: BackupJob["type"], stderr: string): BackupJob {
    const jobId = Bun.randomUUIDv7();
    const completed = Promise.withResolvers<BackupJob>();
    const now = Date.now();
    const job: BackupJob = {
        id: jobId,
        type,
        status: "needs_attention",
        code: 130,
        stdout: "",
        stderr,
        startedAt: now,
        endedAt: now,
        completed: completed.promise,
    };
    backupJobs.set(jobId, job);
    if (type === "kopia") {
        backupRouteState.activeKopiaJobId = jobId;
    } else {
        backupRouteState.activeWalgJobId = jobId;
    }
    completed.resolve(job);
    return job;
}

/** Performs start backup job. */
function startBackupJob(
    type: BackupJob["type"],
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
    const completed = Promise.withResolvers<BackupJob>();
    const job: BackupJob = {
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
                job.stderr = trimOutput(
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
                job.stderr = trimOutput(
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
        job.stderr = trimOutput(`${job.stderr}\nBackup aborted by scheduler`.trim());
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
                    job.stderr = trimOutput(
                        `${job.stderr}\nFailed to force terminate backup process: ${String(error)}`.trim()
                    );
                    void markNeedsAttention();
                }
            }, BACKUP_ABORT_SIGKILL_GRACE_MS);
            hostAbortKillTimer.unref();
        } catch (error) {
            job.stderr = trimOutput(
                `${job.stderr}\nFailed to terminate backup process: ${String(error)}`.trim()
            );
            void markNeedsAttention();
        }
    };

    signal?.addEventListener("abort", abortBackup, { once: true });

    const stdoutDone = pipeProcessOutput(
        child.stdout as ReadableStream<Uint8Array> | undefined,
        (data) => {
            job.stdout = trimOutput(job.stdout + String(data));
        }
    );

    const stderrDone = pipeProcessOutput(
        child.stderr as ReadableStream<Uint8Array> | undefined,
        (data) => {
            job.stderr = trimOutput(job.stderr + String(data));
        }
    );

    void (async () => {
        const code = await child.exited;
        await Promise.all([stdoutDone, stderrDone]);
        return code;
    })()
        .then(async (code) => {
            await finalizeJob(code, isAbortRequested ? "SIGTERM" : undefined);
        })
        .catch(async (error: unknown) => {
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
            job.stderr = trimOutput(
                `${job.stderr}\n${error instanceof Error ? error.message : String(error)}`.trim()
            );
            job.endedAt = Date.now();
            if (signal) {
                signal.removeEventListener("abort", abortBackup);
            }
            completed.resolve(job);
            await refreshBackupStatus(type, job);
        });

    return job;
}

function runDockerExec(
    container: string,
    arguments_: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
    return runProcess("docker", ["exec", container, ...arguments_], {
        env: process.env,
        timeoutMs: backupAbortDockerExecTimeoutMs,
    });
}

function shellSingleQuote(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function pgrepFullCommandPattern(pattern: string): string {
    const lastSlash = pattern.lastIndexOf("/");
    const suffixOffset = lastSlash + 1;
    const suffixMatch = /[A-Za-z0-9]/u.exec(pattern.slice(suffixOffset));
    if (!suffixMatch) {
        return pattern.replace(/[A-Za-z0-9]/u, (match) => `[${match}]`);
    }
    const index = suffixOffset + suffixMatch.index;
    return `${pattern.slice(0, index)}[${pattern[index]}]${pattern.slice(index + 1)}`;
}

async function runContainerPgrep(config: BackupAbortConfig) {
    const processPattern = pgrepFullCommandPattern(config.processPattern);
    return runDockerExec(config.container, [
        "sh",
        "-c",
        [
            `pgrep -f -- ${shellSingleQuote(processPattern)} >/dev/null`,
            "code=$?",
            String.raw`if [ "$code" -eq 1 ]; then printf '%s\n' ${shellSingleQuote(CONTAINER_PGREP_NO_MATCH_MARKER)}; fi`,
            'exit "$code"',
        ].join("; "),
    ]);
}

function isContainerPgrepNoMatch(result: { code: number; stdout: string }): boolean {
    return result.code === 1 && result.stdout.includes(CONTAINER_PGREP_NO_MATCH_MARKER);
}

async function assertNoContainerBackupInProgress(
    config: BackupAbortConfig,
    type: BackupJob["type"],
    getCurrent: () => BackupJob | undefined
): Promise<BackupJob | undefined> {
    const result = await runContainerPgrep(config);
    if (isContainerPgrepNoMatch(result)) {
        return undefined;
    }
    if (result.code === 0) {
        const currentJob = getCurrent();
        if (currentJob?.status === "running") {
            return currentJob;
        }
        if (currentJob?.status === "needs_attention") {
            throw Object.assign(
                new Error(`${type.toUpperCase()} backup needs attention`),
                {
                    statusCode: 409,
                }
            );
        }
        recordBackupNeedsAttention(
            type,
            `${type.toUpperCase()} backup needs attention: backup process is still running`
        );
        throw Object.assign(
            new Error(
                `${type.toUpperCase()} backup needs attention: backup process is still running`
            ),
            { statusCode: 409 }
        );
    }
    throw Object.assign(
        new Error(result.stderr || `docker exec pgrep exited ${result.code}`),
        { statusCode: 503 }
    );
}

function runHostPgrep(
    pattern: string
): Promise<{ code: number; stderr: string; stdout: string }> {
    return runProcess("pgrep", ["-f", pattern], {
        env: process.env,
        timeoutMs: backupAbortDockerExecTimeoutMs,
    });
}

async function assertNoHostBackupInProgress(
    type: BackupJob["type"],
    processPattern: string,
    getCurrent: () => BackupJob | undefined
): Promise<BackupJob | undefined> {
    const result = await runHostPgrep(processPattern);
    if (result.code === 1) {
        return undefined;
    }
    if (result.code === 0) {
        const currentJob = getCurrent();
        if (currentJob?.status === "running") {
            return currentJob;
        }
        if (currentJob?.status === "needs_attention") {
            throw Object.assign(
                new Error(`${type.toUpperCase()} backup needs attention`),
                {
                    statusCode: 409,
                }
            );
        }
        recordBackupNeedsAttention(
            type,
            `${type.toUpperCase()} backup needs attention: backup process is still running`
        );
        throw Object.assign(
            new Error(
                `${type.toUpperCase()} backup needs attention: backup process is still running`
            ),
            { statusCode: 409 }
        );
    }
    throw Object.assign(new Error(result.stderr || `pgrep exited ${result.code}`), {
        statusCode: 503,
    });
}

async function terminateContainerProcess(
    config: BackupAbortConfig,
    signalName: NodeJS.Signals
): Promise<void> {
    const pkillSignalName = signalName.replace(/^SIG/u, "");
    const result = await runDockerExec(config.container, [
        "pkill",
        `-${pkillSignalName}`,
        "-f",
        config.processPattern,
    ]);
    if (result.code > 1) {
        throw new Error(result.stderr || `docker exec pkill exited ${result.code}`);
    }
}

async function waitForContainerProcessExit(config: BackupAbortConfig): Promise<void> {
    const deadline = Date.now() + backupAbortContainerWaitMs;
    while (Date.now() < deadline) {
        const result = await runContainerPgrep(config);
        if (isContainerPgrepNoMatch(result)) {
            return;
        }
        if (result.code !== 0) {
            throw new Error(result.stderr || `docker exec pgrep exited ${result.code}`);
        }
        await new Promise((resolve) => setTimeout(resolve, backupAbortContainerPollMs));
    }
    throw new Error(`Timed out waiting for ${config.processPattern} to exit`);
}

async function waitForContainerProcessExitWithRetries(
    config: BackupAbortConfig,
    job: BackupJob
): Promise<boolean> {
    for (let attempt = 1; attempt <= backupAbortContainerConfirmAttempts; attempt += 1) {
        try {
            await waitForContainerProcessExit(config);
            return true;
        } catch (error: unknown) {
            job.stderr = trimOutput(
                `${job.stderr}\nFailed to confirm backup process termination: ${String(error)}`.trim()
            );
            if (attempt >= backupAbortContainerConfirmAttempts) {
                job.stderr = trimOutput(
                    `${job.stderr}\nBackup termination needs attention after ${attempt} failed confirmation attempts`.trim()
                );
                return false;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, backupAbortContainerPollMs)
            );
        }
    }
    return false;
}

async function waitForHostProcessExit(processPattern: string): Promise<void> {
    const deadline = Date.now() + backupAbortContainerWaitMs;
    while (Date.now() < deadline) {
        const result = await runHostPgrep(processPattern);
        if (result.code === 1) {
            return;
        }
        if (result.code !== 0) {
            throw new Error(result.stderr || `pgrep exited ${result.code}`);
        }
        await new Promise((resolve) => setTimeout(resolve, backupAbortContainerPollMs));
    }
    throw new Error(`Timed out waiting for ${processPattern} to exit`);
}

async function waitForHostProcessExitWithRetries(
    processPattern: string,
    job: BackupJob
): Promise<boolean> {
    for (let attempt = 1; attempt <= backupAbortContainerConfirmAttempts; attempt += 1) {
        try {
            await waitForHostProcessExit(processPattern);
            return true;
        } catch (error: unknown) {
            job.stderr = trimOutput(
                `${job.stderr}\nFailed to confirm backup process termination: ${String(error)}`.trim()
            );
            if (attempt >= backupAbortContainerConfirmAttempts) {
                job.stderr = trimOutput(
                    `${job.stderr}\nBackup termination needs attention after ${attempt} failed confirmation attempts`.trim()
                );
                return false;
            }
            await new Promise((resolve) =>
                setTimeout(resolve, backupAbortContainerPollMs)
            );
        }
    }
    return false;
}

async function refreshBackupStatus(
    type: BackupJob["type"],
    job: BackupJob
): Promise<void> {
    const cacheKey = backupStatusCacheKey(type);
    try {
        await refreshCacheProducer(cacheKey, undefined, { force: true });
    } catch (error) {
        job.stderr = trimOutput(
            `${job.stderr}\nStatus refresh failed: ${String(error)}`.trim()
        );
    }
    job.statusRefreshed = true;
}

/** Performs start kopia backup job. */
async function startKopiaBackupJob(signal?: AbortSignal) {
    const existingJob = getCurrentKopiaJob();
    if (existingJob?.status === "running") {
        return existingJob;
    }
    if (existingJob?.status === "needs_attention") {
        throw Object.assign(new Error("KOPIA backup needs attention"), {
            statusCode: 409,
        });
    }
    let hostJob: BackupJob | undefined;
    try {
        hostJob = await assertNoHostBackupInProgress(
            "kopia",
            KOPIA_BACKUP_SCRIPT_PATTERN,
            getCurrentKopiaJob
        );
    } catch (error) {
        try {
            await refreshCacheProducer(backupStatusCacheKey("kopia"));
        } catch {
            // Preserve the original preflight failure for the API response.
        }
        throw error;
    }
    if (hostJob) {
        return hostJob;
    }
    return startBackupJob(
        "kopia",
        KOPIA_BACKUP_SCRIPT_PATTERN,
        signal,
        undefined,
        KOPIA_BACKUP_SCRIPT_PATTERN
    );
}

/** Performs start walg backup job. */
async function startWalgBackupJob(signal?: AbortSignal) {
    const abortConfig = {
        container: "walg",
        processPattern: WALG_BACKUP_SCRIPT_PATTERN,
    };
    const existingJob = getCurrentWalgJob();
    if (existingJob?.status === "running") {
        return existingJob;
    }
    if (existingJob?.status === "needs_attention") {
        throw Object.assign(new Error("WALG backup needs attention"), {
            statusCode: 409,
        });
    }
    let containerJob: BackupJob | undefined;
    try {
        containerJob = await assertNoContainerBackupInProgress(
            abortConfig,
            "walg",
            getCurrentWalgJob
        );
    } catch (error) {
        try {
            await refreshCacheProducer(backupStatusCacheKey("walg"));
        } catch (refreshError) {
            console.warn(
                "[Backups] Failed to refresh WAL-G status after preflight failure:",
                refreshError
            );
            // Preserve the original preflight failure for the API response.
        }
        throw error;
    }
    if (containerJob) {
        return containerJob;
    }
    return startBackupJob(
        "walg",
        "docker exec walg /bin/sh /usr/local/bin/backup-push.sh",
        signal,
        abortConfig
    );
}

async function startScheduledBackup(
    type: BackupJob["type"],
    signal: AbortSignal | undefined,
    context: ScheduledJobActionContext
) {
    if (signal?.aborted) {
        throw new Error("Backup aborted by scheduler");
    }
    const previousExecution = getPreviousScheduledJobExecution(
        scheduledBackupJobId(type),
        context.executionId
    );
    const persistedJob = persistedBackupViewFromExecution(type, previousExecution);
    if (persistedJob?.status === "needs_attention") {
        throw Object.assign(
            new ScheduledJobActionError(`${type.toUpperCase()} backup needs attention`, {
                backup: persistedJob,
            }),
            { statusCode: 409 }
        );
    }
    const currentJob = getCurrentBackupJob(type);
    if (currentJob?.status === "needs_attention") {
        throw Object.assign(
            new ScheduledJobActionError(`${type.toUpperCase()} backup needs attention`, {
                backup: mapBackupJob(currentJob),
            }),
            { statusCode: 409 }
        );
    }
    if (currentJob?.status === "running") {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup is already running`),
            { statusCode: 409 }
        );
    }
    let job: BackupJob;
    try {
        job = await startManualBackup(type, signal);
    } catch (error) {
        const attentionJob = getCurrentBackupJob(type);
        if (attentionJob?.status === "needs_attention") {
            throw Object.assign(
                new ScheduledJobActionError(
                    errorMessage(error, `${type.toUpperCase()} backup needs attention`),
                    { backup: mapBackupJob(attentionJob) }
                ),
                { statusCode: 409 }
            );
        }
        throw error;
    }
    const publish = () => context.updateOutput({ backup: mapBackupJob(job) });
    publish();
    const progress = setInterval(publish, 1000);
    progress.unref();
    let completedJob: BackupJob;
    try {
        completedJob = await job.completed;
    } finally {
        clearInterval(progress);
        publish();
    }
    if (completedJob.code !== 0) {
        const details = completedJob.stderr || completedJob.stdout;
        throw new Error(
            `${type.toUpperCase()} backup failed with code ${completedJob.code}${
                details ? `: ${details}` : ""
            }`
        );
    }
    return { backup: mapBackupJob(completedJob) };
}

function scheduledBackupJobId(type: BackupJob["type"]) {
    return type === "kopia" ? "backup.kopia" : "backup.walg";
}

export function getCurrentBackupJob(type: BackupJob["type"]): BackupJob | undefined {
    return (type === "kopia" ? getCurrentKopiaJob : getCurrentWalgJob)();
}

/** Worker primitive. HTTP callers must enqueue the registered backup action. */
export async function startManualBackup(type: BackupJob["type"], signal?: AbortSignal) {
    const existingJob = getCurrentBackupJob(type);
    if (existingJob?.status === "running") return existingJob;
    return type === "kopia"
        ? await startKopiaBackupJob(signal)
        : await startWalgBackupJob(signal);
}

function backupViewFromExecution(
    type: BackupJob["type"],
    execution: JobExecution | undefined
) {
    if (!execution) return;
    const backup = execution.output.backup;
    if (backup && typeof backup === "object" && !Array.isArray(backup)) {
        return backup as ReturnType<typeof mapBackupJob>;
    }
    return {
        code: undefined,
        endedAt: execution.finishedAt ? Date.parse(execution.finishedAt) : undefined,
        id: execution.id,
        startedAt: Date.parse(execution.startedAt ?? execution.queuedAt),
        status:
            execution.status === "failed" || execution.status === "cancelled"
                ? execution.status
                : execution.finishedAt
                  ? "done"
                  : "running",
        stderr: execution.message ?? "",
        stdout: "",
        type,
    } as const;
}

function persistedBackupViewFromExecution(
    type: BackupJob["type"],
    execution: JobExecution | undefined
) {
    if (!execution || wasBackupAttentionClearedAfter(type, execution)) return;
    return backupViewFromExecution(type, execution);
}

export function getPersistedBackupJob(type: BackupJob["type"]) {
    return persistedBackupViewFromExecution(
        type,
        getLatestScheduledJobExecution(scheduledBackupJobId(type))
    );
}

function wasBackupAttentionClearedAfter(
    type: BackupJob["type"],
    execution: JobExecution
): boolean {
    return Boolean(
        database
            .prepare(
                `SELECT 1
                 FROM job_executions
                 WHERE action_key = 'backup.clear-attention'
                   AND status = 'success'
                   AND json_valid(payload_json)
                   AND json_extract(payload_json, '$.type') = ?
                   AND json_extract(payload_json, '$.backupExecutionId') = ?
                 ORDER BY queued_at DESC, id DESC
                 LIMIT 1`
            )
            .get(type, execution.id)
    );
}

export function queueManualBackup(type: BackupJob["type"]) {
    if (getPersistedBackupJob(type)?.status === "needs_attention") {
        throw Object.assign(new Error(`${type.toUpperCase()} backup needs attention`), {
            statusCode: 409,
        });
    }
    const scheduledRun = enqueueScheduledJob(scheduledBackupJobId(type), "manual");
    return backupViewFromExecution(
        type,
        scheduledRun.executionId ? getJobExecution(scheduledRun.executionId) : undefined
    );
}

export async function clearPersistedBackupAttention(type: BackupJob["type"]) {
    let execution: JobExecution;
    database.run("BEGIN IMMEDIATE");
    try {
        const backupExecutionId = getLatestScheduledJobExecution(
            scheduledBackupJobId(type)
        )?.id;
        if (!backupExecutionId) {
            throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
                statusCode: 404,
            });
        }
        execution = enqueueJobExecution({
            actionKey: "backup.clear-attention",
            displayName: `Clear ${type.toUpperCase()} backup attention`,
            payload: { backupExecutionId, type },
            resourceClass: "light",
            timeoutMs: 5 * 60 * 1000,
        });
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch {
            // Preserve the queue error.
        }
        throw error;
    }
    const completed = await waitForJobExecution(execution.id, {
        timeoutMs: 15 * 60 * 1000,
    });
    const output = successfulJobExecutionOutput(completed);
    return output.backup as ReturnType<typeof mapBackupJob>;
}

async function clearBackupAttention(type: BackupJob["type"], backupExecutionId: string) {
    const latestExecution = getLatestScheduledJobExecution(scheduledBackupJobId(type));
    if (!latestExecution) {
        throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
            statusCode: 404,
        });
    }
    if (latestExecution.id !== backupExecutionId) {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup attention changed before clearing`),
            { statusCode: 409 }
        );
    }

    const current = getCurrentBackupJob(type);
    if (current) {
        return mapBackupJob(await clearNeedsAttentionBackupJob(type));
    }

    const persisted = getPersistedBackupJob(type);
    if (!persisted) {
        throw Object.assign(new Error(`${type.toUpperCase()} backup job not found`), {
            statusCode: 404,
        });
    }
    if (persisted.status !== "needs_attention") {
        throw Object.assign(
            new Error(`${type.toUpperCase()} backup does not need attention`),
            { statusCode: 409 }
        );
    }

    const cleared = { ...persisted };
    try {
        await refreshCacheProducer(backupStatusCacheKey(type), undefined, {
            force: true,
        });
    } catch (error) {
        const stderr = typeof cleared.stderr === "string" ? cleared.stderr : "";
        cleared.stderr = trimOutput(
            `${stderr}\nStatus refresh failed: ${String(error)}`.trim()
        );
    }
    return cleared;
}

async function terminateContainerProcessSafely(
    abortConfig: BackupAbortConfig,
    signal: NodeJS.Signals,
    job: BackupJob
): Promise<void> {
    try {
        await terminateContainerProcess(abortConfig, signal);
    } catch (error) {
        const message =
            signal === "SIGTERM"
                ? "Failed to terminate container backup process"
                : "Failed to force terminate container backup process";
        job.stderr = trimOutput(`${job.stderr}\n${message}: ${String(error)}`.trim());
    }
}

const backupScheduledJobs = [
    {
        id: "backup.walg",
        name: "WAL-G backup",
        description: "Run a WAL-G PostgreSQL base backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:20",
        actionKey: "backup.run",
        actionPayload: { type: "walg" },
        resourceClass: "host-heavy",
    },
    {
        id: "backup.kopia",
        name: "Kopia backup",
        description: "Run a Kopia filesystem backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:50",
        actionKey: "backup.run",
        actionPayload: { type: "kopia" },
        resourceClass: "host-heavy",
    },
] as const;

export function registerBackupScheduledJobs(): void {
    registerScheduledJobAction(
        "backup.run",
        (job, signal, context) => {
            const type = getScheduledBackupType(job.actionPayload);
            if (type !== "kopia" && type !== "walg") {
                throw Object.assign(
                    new Error(`Scheduled backup job ${job.id} has invalid backup type`),
                    { statusCode: 400 }
                );
            }
            return startScheduledBackup(type, signal, context);
        },
        { timeoutMs: SCHEDULED_BACKUP_TIMEOUT_MS }
    );
    registerScheduledJobAction("backup.clear-attention", async (job) => {
        const type = getScheduledBackupType(job.actionPayload);
        if (type !== "kopia" && type !== "walg") {
            throw Object.assign(new Error("Invalid backup type"), { statusCode: 400 });
        }
        const backupExecutionId = job.actionPayload.backupExecutionId;
        if (typeof backupExecutionId !== "string" || backupExecutionId.trim() === "") {
            throw Object.assign(new Error("Backup execution id is missing"), {
                statusCode: 400,
            });
        }
        return { backup: await clearBackupAttention(type, backupExecutionId) };
    });
    database.run("BEGIN");
    try {
        removeScheduledJobsNotInAction(
            "backup.run",
            backupScheduledJobs.map((job) => job.id)
        );

        for (const job of backupScheduledJobs) {
            const existing = getScheduledJob(job.id);
            upsertScheduledJob({
                ...job,
                enabled: existing?.enabled ?? true,
                scheduleType: existing?.scheduleType ?? job.scheduleType,
                intervalSeconds: existing?.intervalSeconds ?? job.intervalSeconds,
                timeOfDay: existing?.timeOfDay ?? job.timeOfDay,
                cronExpression:
                    existing?.cronExpression ??
                    ("cronExpression" in job && typeof job.cronExpression === "string"
                        ? job.cronExpression
                        : undefined),
            });
        }
        database.run("COMMIT");
    } catch (error) {
        database.run("ROLLBACK");
        throw error;
    }
}
