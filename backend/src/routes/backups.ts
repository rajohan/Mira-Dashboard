import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import express, { type RequestHandler } from "express";

import { db } from "../db.js";
import { asyncRoute, errorMessage } from "../lib/errors.js";
import { refreshCacheProducer } from "../services/cacheRefresh.js";
import {
    createManualScheduledJobRun,
    finishScheduledJobRun,
    getScheduledJob,
    registerScheduledJobAction,
    removeScheduledJobsNotInAction,
    type ScheduledJobRun,
    upsertScheduledJob,
} from "../services/scheduledJobs.js";
const MAX_OUTPUT_CHARS = 100_000;
const SCHEDULED_BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const BACKUP_ABORT_SIGKILL_GRACE_MS = 10_000;
const KOPIA_BACKUP_SCRIPT_PATTERN = "/opt/docker/apps/kopia/backup.sh";
const WALG_BACKUP_SCRIPT_PATTERN = "/usr/local/bin/backup-push.sh";
const CONTAINER_PGREP_NO_MATCH_MARKER = "__MIRA_CONTAINER_PGREP_NO_MATCH__";
let spawnBackupProcess = spawn;
let backupAbortContainerWaitMs = 30_000;
let backupAbortContainerPollMs = 1_000;
let backupAbortContainerConfirmAttempts = 3;
let backupAbortDockerExecTimeoutMs = 5_000;

interface BackupAbortConfig {
    container: string;
    processPattern: string;
}

/** Represents backup job. */
interface BackupJob {
    id: string;
    type: "kopia" | "walg";
    status: "running" | "done" | "needs_attention";
    code: number | null;
    stdout: string;
    stderr: string;
    startedAt: number;
    endedAt: number | null;
    completed: Promise<BackupJob>;
    process?: ChildProcess;
    statusRefreshed?: boolean;
    manualScheduledRun?: ScheduledJobRun;
}

/** Represents the backup job API response. */
interface BackupJobResponse {
    job: null | {
        id: string;
        type: BackupJob["type"];
        status: BackupJob["status"];
        code: number | null;
        stdout: string;
        stderr: string;
        startedAt: number;
        endedAt: number | null;
    };
}

const backupJobs = new Map<string, BackupJob>();
let activeKopiaJobId: string | null = null;
let activeWalgJobId: string | null = null;

/** Performs trim output. */
function trimOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_CHARS) {
        return text;
    }
    return text.slice(-MAX_OUTPUT_CHARS);
}

/** Returns current job. */
function getCurrentJob(activeJobId: string | null, clear: () => void) {
    if (!activeJobId) {
        return null;
    }
    const job = backupJobs.get(activeJobId) ?? null;
    if (!job) {
        clear();
        return null;
    }

    if (job.status === "done") {
        clear();
    }

    return job;
}

/** Returns current kopia job. */
function getCurrentKopiaJob() {
    return getCurrentJob(activeKopiaJobId, () => {
        activeKopiaJobId = null;
    });
}

/** Returns current walg job. */
function getCurrentWalgJob() {
    return getCurrentJob(activeWalgJobId, () => {
        activeWalgJobId = null;
    });
}

/** Performs map job. */
function mapJob(job: BackupJob | null) {
    if (!job) {
        return null;
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

async function clearNeedsAttentionBackupJob(type: BackupJob["type"]) {
    const job = getCurrentBackupJob(type);
    if (!job) {
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
    if (type === "kopia" && activeKopiaJobId === job.id) {
        activeKopiaJobId = null;
    }
    if (type === "walg" && activeWalgJobId === job.id) {
        activeWalgJobId = null;
    }
    await refreshBackupStatus(type, job);
    return job;
}

function recordBackupNeedsAttention(type: BackupJob["type"], stderr: string): BackupJob {
    const jobId = randomUUID();
    let resolveCompleted!: (job: BackupJob) => void;
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
        completed: new Promise<BackupJob>((resolve) => {
            resolveCompleted = resolve;
        }),
    };
    backupJobs.set(jobId, job);
    if (type === "kopia") {
        activeKopiaJobId = jobId;
    } else {
        activeWalgJobId = jobId;
    }
    resolveCompleted(job);
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

    const jobId = randomUUID();
    let resolveCompleted!: (job: BackupJob) => void;
    const job: BackupJob = {
        id: jobId,
        type,
        status: "running",
        code: null,
        stdout: "",
        stderr: "",
        startedAt: Date.now(),
        endedAt: null,
        completed: new Promise<BackupJob>((resolve) => {
            resolveCompleted = resolve;
        }),
    };

    backupJobs.set(jobId, job);
    if (type === "kopia") {
        activeKopiaJobId = jobId;
    } else {
        activeWalgJobId = jobId;
    }

    let child: ReturnType<typeof spawn>;
    try {
        child = spawnBackupProcess("bash", ["-lc", command], {
            detached: true,
            env: process.env,
        });
    } catch (error) {
        backupJobs.delete(jobId);
        if (activeKopiaJobId === jobId) {
            activeKopiaJobId = null;
        }
        if (activeWalgJobId === jobId) {
            activeWalgJobId = null;
        }
        throw error;
    }

    job.process = child;
    let finalized = false;
    let finalizing = false;
    let abortRequested = false;
    let hostAbortKillTimer: NodeJS.Timeout | null = null;
    let containerAbortKillTimer: NodeJS.Timeout | null = null;

    const finalizeJob = async (code: number, signalName: NodeJS.Signals | null) => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        if (hostAbortKillTimer) {
            clearTimeout(hostAbortKillTimer);
            hostAbortKillTimer = null;
        }
        const interrupted = abortRequested || signalName !== null;
        let needsAttention =
            interrupted && abortConfig
                ? !(await waitForContainerProcessExitWithRetries(abortConfig, job))
                : false;
        if (interrupted && hostAbortPattern) {
            needsAttention = !(await waitForHostProcessExitWithRetries(
                hostAbortPattern,
                job
            ));
        }
        if (containerAbortKillTimer) {
            clearTimeout(containerAbortKillTimer);
            containerAbortKillTimer = null;
        }
        const completedCode = interrupted ? 130 : code;
        job.status = needsAttention ? "needs_attention" : "done";
        job.code = completedCode;
        job.endedAt = Date.now();
        finalized = true;
        signal?.removeEventListener("abort", abortBackup);
        resolveCompleted(job);
        await refreshBackupStatus(type, job);
    };

    const markNeedsAttention = async () => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        if (hostAbortKillTimer) {
            clearTimeout(hostAbortKillTimer);
            hostAbortKillTimer = null;
        }
        if (containerAbortKillTimer) {
            clearTimeout(containerAbortKillTimer);
            containerAbortKillTimer = null;
        }
        job.status = "needs_attention";
        job.code = 130;
        job.endedAt = Date.now();
        finalized = true;
        signal?.removeEventListener("abort", abortBackup);
        resolveCompleted(job);
        await refreshBackupStatus(type, job);
    };

    const abortBackup = () => {
        abortRequested = true;
        job.stderr = trimOutput(`${job.stderr}\nBackup aborted by scheduler`.trim());
        if (abortConfig) {
            void terminateContainerProcessSafely(abortConfig, "SIGTERM", job);
            containerAbortKillTimer = setTimeout(() => {
                void terminateContainerProcessSafely(abortConfig, "SIGKILL", job);
            }, BACKUP_ABORT_SIGKILL_GRACE_MS);
            containerAbortKillTimer.unref();
        }
        try {
            if (typeof child.pid === "number") {
                const childPid = child.pid;
                const processGroupId = -childPid;
                process.kill(processGroupId, "SIGTERM");
                hostAbortKillTimer = setTimeout(() => {
                    try {
                        process.kill(processGroupId, "SIGKILL");
                    } catch (error) {
                        job.stderr = trimOutput(
                            `${job.stderr}\nFailed to force terminate backup process group: ${String(error)}`.trim()
                        );
                        try {
                            process.kill(childPid, "SIGKILL");
                        } catch (childKillError) {
                            job.stderr = trimOutput(
                                `${job.stderr}\nFailed to force terminate backup process: ${String(childKillError)}`.trim()
                            );
                            void markNeedsAttention();
                        }
                    }
                }, BACKUP_ABORT_SIGKILL_GRACE_MS);
                hostAbortKillTimer.unref();
            } else if (!child.kill("SIGTERM")) {
                job.stderr = trimOutput(
                    `${job.stderr}\nFailed to terminate backup process`.trim()
                );
                void finalizeJob(130, "SIGTERM");
            }
        } catch (error) {
            job.stderr = trimOutput(
                `${job.stderr}\nFailed to terminate backup process: ${String(error)}`.trim()
            );
            void finalizeJob(130, "SIGTERM");
        }
    };

    signal?.addEventListener("abort", abortBackup, { once: true });

    child.stdout?.on("data", (data) => {
        job.stdout = trimOutput(job.stdout + String(data));
    });

    child.stderr?.on("data", (data) => {
        job.stderr = trimOutput(job.stderr + String(data));
    });

    child.on("close", async (code, signal) => {
        await finalizeJob(signal ? 130 : (code ?? 1), signal);
    });

    child.on("error", async (error) => {
        if (finalized || finalizing) {
            return;
        }
        finalizing = true;
        if (hostAbortKillTimer) {
            clearTimeout(hostAbortKillTimer);
            hostAbortKillTimer = null;
        }
        if (containerAbortKillTimer) {
            clearTimeout(containerAbortKillTimer);
            containerAbortKillTimer = null;
        }
        finalized = true;
        job.status = "done";
        job.code = 1;
        job.stderr = trimOutput(`${job.stderr}\n${error.message}`.trim());
        job.endedAt = Date.now();
        if (signal) {
            signal.removeEventListener("abort", abortBackup);
        }
        resolveCompleted(job);
        await refreshBackupStatus(type, job);
    });

    return job;
}

function runDockerExec(
    container: string,
    args: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawnBackupProcess("docker", ["exec", container, ...args], {
            detached: true,
            env: process.env,
        });
        const timeout = setTimeout(() => {
            try {
                if (typeof child.pid === "number") {
                    process.kill(-child.pid, "SIGKILL");
                    reject(new Error(`Timed out waiting for docker exec ${args[0]}`));
                    return;
                }
            } catch {
                // Fall back to the direct child handle when process-group kill fails.
            }
            try {
                child.kill("SIGKILL");
            } catch {
                // The timeout error below is still the actionable failure.
            }
            reject(new Error(`Timed out waiting for docker exec ${args[0]}`));
        }, backupAbortDockerExecTimeoutMs);
        timeout.unref();
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (data) => {
            stdout = trimOutput(stdout + String(data));
        });
        child.stderr?.on("data", (data) => {
            stderr = trimOutput(stderr + String(data));
        });
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ code: code ?? 1, stdout, stderr });
        });
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
    getCurrent: () => BackupJob | null
): Promise<BackupJob | null> {
    const result = await runContainerPgrep(config);
    if (isContainerPgrepNoMatch(result)) {
        return null;
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

function runHostPgrep(pattern: string): Promise<{ code: number; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawnBackupProcess("pgrep", ["-f", pattern], {
            detached: true,
            env: process.env,
        });
        const timeout = setTimeout(() => {
            try {
                if (typeof child.pid === "number") {
                    process.kill(-child.pid, "SIGKILL");
                } else {
                    child.kill("SIGKILL");
                }
            } catch {
                try {
                    child.kill("SIGKILL");
                } catch {
                    // The timeout error below is still the actionable failure.
                }
            }
            reject(new Error(`Timed out waiting for pgrep ${pattern}`));
        }, backupAbortDockerExecTimeoutMs);
        timeout.unref();
        let stderr = "";
        child.stderr?.on("data", (data) => {
            stderr = trimOutput(stderr + String(data));
        });
        child.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ code: code ?? 1, stderr });
        });
    });
}

async function assertNoHostBackupInProgress(
    type: BackupJob["type"],
    processPattern: string,
    getCurrent: () => BackupJob | null
): Promise<BackupJob | null> {
    const result = await runHostPgrep(processPattern);
    if (result.code === 1) {
        return null;
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
    let hostJob: BackupJob | null;
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
    let containerJob: BackupJob | null;
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

async function startScheduledBackup(type: BackupJob["type"], signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new Error("Backup aborted by scheduler");
    }
    const currentJob = getCurrentBackupJob(type);
    if (currentJob?.status === "running" || currentJob?.status === "needs_attention") {
        throw Object.assign(
            new Error(
                currentJob.status === "needs_attention"
                    ? `${type.toUpperCase()} backup needs attention`
                    : `${type.toUpperCase()} backup is already running`
            ),
            {
                statusCode: 409,
            }
        );
    }
    const job =
        type === "kopia"
            ? await startKopiaBackupJob(signal)
            : await startWalgBackupJob(signal);
    const completedJob = await job.completed;
    if (completedJob.code !== 0) {
        const details = completedJob.stderr || completedJob.stdout;
        throw new Error(
            `${type.toUpperCase()} backup failed with code ${completedJob.code}${
                details ? `: ${details}` : ""
            }`
        );
    }
    return { backup: mapJob(completedJob) };
}

function scheduledBackupJobId(type: BackupJob["type"]) {
    return type === "kopia" ? "backup.kopia" : "backup.walg";
}

function createBackupManualScheduledRun(type: BackupJob["type"]) {
    const jobId = scheduledBackupJobId(type);
    if (!getScheduledJob(jobId)) {
        return null;
    }
    return createManualScheduledJobRun(jobId);
}

function backupFailureMessage(job: BackupJob) {
    if (job.status === "needs_attention") {
        return `${job.type.toUpperCase()} backup needs attention`;
    }
    if (job.code === 0) {
        return null;
    }
    const details = job.stderr || job.stdout;
    return `${job.type.toUpperCase()} backup failed with code ${job.code ?? 1}${
        details ? `: ${details}` : ""
    }`;
}

function attachManualScheduledRun(job: BackupJob): void {
    if (job.manualScheduledRun || job.status !== "running") {
        return;
    }
    let run: ScheduledJobRun;
    try {
        const scheduledRun = createBackupManualScheduledRun(job.type);
        if (!scheduledRun) {
            return;
        }
        run = scheduledRun;
    } catch (error) {
        console.warn("[Backups] Failed to record manual backup run:", error);
        return;
    }
    job.manualScheduledRun = run;
    void finishManualScheduledRunWhenComplete(job, run);
}

async function finishManualScheduledRunWhenComplete(
    job: BackupJob,
    run: ScheduledJobRun
): Promise<void> {
    try {
        const completedJob = await job.completed;
        const success = completedJob.status === "done" && completedJob.code === 0;
        finishScheduledJobRun(
            run,
            success ? "success" : "failed",
            success ? null : backupFailureMessage(completedJob),
            { backup: mapJob(completedJob) }
        );
    } catch (error) {
        console.warn("[Backups] Failed to finish manual backup run:", error);
    }
}

function getCurrentBackupJob(type: BackupJob["type"]): BackupJob | null {
    return (type === "kopia" ? getCurrentKopiaJob : getCurrentWalgJob)();
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

async function startManualBackup(type: BackupJob["type"]) {
    const existingJob = getCurrentBackupJob(type);
    if (existingJob?.status === "running") {
        return existingJob;
    }
    try {
        const job =
            type === "kopia" ? await startKopiaBackupJob() : await startWalgBackupJob();
        attachManualScheduledRun(job);
        return job;
    } catch (error) {
        try {
            const failedRun = createBackupManualScheduledRun(type);
            if (failedRun) {
                finishScheduledJobRun(
                    failedRun,
                    "failed",
                    errorMessage(error, `${type.toUpperCase()} backup failed to start`),
                    {}
                );
            }
        } catch (runError) {
            console.warn(
                "[Backups] Failed to record failed manual backup run:",
                runError
            );
        }
        throw error;
    }
}

const backupScheduledJobs = [
    {
        id: "backup.walg",
        name: "WAL-G nightly backup",
        description: "Run the nightly WAL-G PostgreSQL base backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:20",
        actionKey: "backup.run",
        actionPayload: { type: "walg" },
    },
    {
        id: "backup.kopia",
        name: "Kopia nightly backup",
        description: "Run the nightly Kopia filesystem backup.",
        scheduleType: "daily",
        intervalSeconds: 24 * 60 * 60,
        timeOfDay: "03:50",
        actionKey: "backup.run",
        actionPayload: { type: "kopia" },
    },
] as const;

export function registerBackupScheduledJobs(): void {
    registerScheduledJobAction(
        "backup.run",
        (job, signal) => {
            const type = getScheduledBackupType(job.actionPayload);
            if (type !== "kopia" && type !== "walg") {
                throw Object.assign(
                    new Error(`Scheduled backup job ${job.id} has invalid backup type`),
                    { statusCode: 400 }
                );
            }
            return startScheduledBackup(type, signal);
        },
        { timeoutMs: SCHEDULED_BACKUP_TIMEOUT_MS }
    );
    db.exec("BEGIN");
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
                cronExpression: existing?.cronExpression ?? null,
            });
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}


/** Registers backup API routes. */
export default function backupRoutes(
    app: express.Application,
    _express: typeof express
): void {
    app.get("/api/backups/kopia", ((_req, res) => {
        res.json({ job: mapJob(getCurrentKopiaJob()) } satisfies BackupJobResponse);
    }) as RequestHandler);

    app.post(
        "/api/backups/kopia/run",
        asyncRoute(
            async (_req, res) => {
                const job = await startManualBackup("kopia");
                res.json({ ok: true, job: mapJob(job) });
            },
            { fallback: "Failed to start Kopia backup" }
        )
    );

    app.post(
        "/api/backups/kopia/clear-needs-attention",
        asyncRoute(
            async (_req, res) => {
                const job = await clearNeedsAttentionBackupJob("kopia");
                res.json({ ok: true, cleared: mapJob(job) });
            },
            { fallback: "Failed to clear Kopia backup attention" }
        )
    );

    app.get("/api/backups/walg", ((_req, res) => {
        res.json({ job: mapJob(getCurrentWalgJob()) } satisfies BackupJobResponse);
    }) as RequestHandler);

    app.post(
        "/api/backups/walg/run",
        asyncRoute(
            async (_req, res) => {
                const job = await startManualBackup("walg");
                res.json({ ok: true, job: mapJob(job) });
            },
            { fallback: "Failed to start WAL-G backup" }
        )
    );

    app.post(
        "/api/backups/walg/clear-needs-attention",
        asyncRoute(
            async (_req, res) => {
                const job = await clearNeedsAttentionBackupJob("walg");
                res.json({ ok: true, cleared: mapJob(job) });
            },
            { fallback: "Failed to clear WAL-G backup attention" }
        )
    );
}
