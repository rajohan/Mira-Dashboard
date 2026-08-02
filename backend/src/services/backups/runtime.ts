import type {
    BackupJob as BackupJobResponse,
    BackupJobStatus,
    BackupType,
} from "../../../../contracts/backups.ts";
import { errorMessage } from "../../lib/errors.ts";
import {
    type BunProcess,
    killProcessGroup,
    pipeProcessOutput,
    runProcess,
    spawnProcess,
} from "../../lib/processes.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { refreshCacheProducer } from "../cacheRefresh.ts";

const logger = createStructuredLogger("backups");
const MAX_OUTPUT_CHARS = 100_000;
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

/** Tracks process-owned state that is not exposed by the backup API contract. */
export interface ActiveBackupJob {
    id: string;
    type: BackupType;
    status: BackupJobStatus;
    code: number | undefined;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | undefined;
    completed: Promise<ActiveBackupJob>;
    process?: BunProcess;
    statusRefreshed?: boolean;
}

const backupJobs = new Map<string, ActiveBackupJob>();
const backupRouteState: {
    activeKopiaJobId: string | undefined;
    activeWalgJobId: string | undefined;
} = {
    activeKopiaJobId: undefined,
    activeWalgJobId: undefined,
};

/**
 * Performs trim output.
 * @param text Text value.
 * @returns Trim output result.
 */
export function trimBackupOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }
    return text.slice(-MAX_OUTPUT_CHARS);
}

/**
 * Returns current job.
 * @param activeJobId Active job identifier.
 * @param clear Clear value.
 * @returns current job.
 */
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

/**
 * Returns current kopia job.
 * @returns current kopia job.
 */
function getCurrentKopiaJob() {
    return getCurrentJob(backupRouteState.activeKopiaJobId, () => {
        backupRouteState.activeKopiaJobId = undefined;
    });
}

/**
 * Returns current walg job.
 * @returns current walg job.
 */
function getCurrentWalgJob() {
    return getCurrentJob(backupRouteState.activeWalgJobId, () => {
        backupRouteState.activeWalgJobId = undefined;
    });
}

/**
 * Performs map job.
 * @returns Map job result.
 */
export function mapBackupJob(job?: ActiveBackupJob): BackupJobResponse | undefined {
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

/**
 * Returns backup type from scheduled job payload.
 * @param payload Request or event payload.
 * @returns backup type from scheduled job payload.
 */
export function getScheduledBackupType(payload: unknown) {
    if (typeof payload !== "object" || payload === null) {
        return;
    }

    return (payload as { type?: unknown }).type;
}

export function backupStatusCacheKey(type: BackupType) {
    return type === "kopia" ? "backup.kopia.status" : "backup.walg.status";
}

function evictCompletedBackupJobs(type: BackupType) {
    for (const [id, job] of backupJobs) {
        if (job.type === type && job.status === "done") {
            backupJobs.delete(id);
        }
    }
}

export async function clearNeedsAttentionBackupJob(type: BackupType) {
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

function recordBackupNeedsAttention(type: BackupType, stderr: string): ActiveBackupJob {
    const jobId = Bun.randomUUIDv7();
    const completed = Promise.withResolvers<ActiveBackupJob>();
    const now = Date.now();
    const job: ActiveBackupJob = {
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

/**
 * Performs start backup job.
 * @param type Type value.
 * @param command Command value.
 * @param signal Signal used to cancel the operation.
 * @param abortConfig Abort config value.
 * @param hostAbortPattern Host abort pattern value.
 * @returns Start backup job result.
 */
function startBackupJob(
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
    type: BackupType,
    getCurrent: () => ActiveBackupJob | undefined
): Promise<ActiveBackupJob | undefined> {
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
    type: BackupType,
    processPattern: string,
    getCurrent: () => ActiveBackupJob | undefined
): Promise<ActiveBackupJob | undefined> {
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
    job: ActiveBackupJob
): Promise<boolean> {
    for (let attempt = 1; attempt <= backupAbortContainerConfirmAttempts; attempt += 1) {
        try {
            await waitForContainerProcessExit(config);
            return true;
        } catch (error: unknown) {
            job.stderr = trimBackupOutput(
                `${job.stderr}\nFailed to confirm backup process termination: ${errorMessage(
                    error,
                    "Unknown error"
                )}`.trim()
            );
            if (attempt >= backupAbortContainerConfirmAttempts) {
                job.stderr = trimBackupOutput(
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
    job: ActiveBackupJob
): Promise<boolean> {
    for (let attempt = 1; attempt <= backupAbortContainerConfirmAttempts; attempt += 1) {
        try {
            await waitForHostProcessExit(processPattern);
            return true;
        } catch (error: unknown) {
            job.stderr = trimBackupOutput(
                `${job.stderr}\nFailed to confirm backup process termination: ${errorMessage(
                    error,
                    "Unknown error"
                )}`.trim()
            );
            if (attempt >= backupAbortContainerConfirmAttempts) {
                job.stderr = trimBackupOutput(
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
    type: BackupType,
    job: ActiveBackupJob
): Promise<void> {
    const cacheKey = backupStatusCacheKey(type);
    try {
        await refreshCacheProducer(cacheKey, undefined, { force: true });
    } catch (error) {
        job.stderr = trimBackupOutput(
            `${job.stderr}\nStatus refresh failed: ${errorMessage(
                error,
                "Unknown error"
            )}`.trim()
        );
    }
    job.statusRefreshed = true;
}

/**
 * Performs start kopia backup job.
 * @returns Start kopia backup job result.
 */
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
    let hostJob: ActiveBackupJob | undefined;
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

/**
 * Performs start walg backup job.
 * @returns Start walg backup job result.
 */
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
    let containerJob: ActiveBackupJob | undefined;
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
            logger.warn("backups.walg_status_refresh_failed", {
                error: refreshError,
            });
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

export function getCurrentBackupJob(type: BackupType): ActiveBackupJob | undefined {
    return (type === "kopia" ? getCurrentKopiaJob : getCurrentWalgJob)();
}

/**
 * Worker primitive. HTTP callers must enqueue the registered backup action.
 * @param type Type value.
 * @param signal Signal used to cancel the operation.
 * @returns Promise resolving to the start manual backup result.
 */
export async function startManualBackup(type: BackupType, signal?: AbortSignal) {
    const existingJob = getCurrentBackupJob(type);
    if (existingJob?.status === "running") return existingJob;
    return type === "kopia"
        ? await startKopiaBackupJob(signal)
        : await startWalgBackupJob(signal);
}

async function terminateContainerProcessSafely(
    abortConfig: BackupAbortConfig,
    signal: NodeJS.Signals,
    job: ActiveBackupJob
): Promise<void> {
    try {
        await terminateContainerProcess(abortConfig, signal);
    } catch (error) {
        const message =
            signal === "SIGTERM"
                ? "Failed to terminate container backup process"
                : "Failed to force terminate container backup process";
        job.stderr = trimBackupOutput(
            `${job.stderr}\n${message}: ${errorMessage(error, "Unknown error")}`.trim()
        );
    }
}
