import type { BackupType } from "../../../../contracts/backups.ts";
import { errorMessage } from "../../lib/errors.ts";
import { runProcess } from "../../lib/processes.ts";
import {
    type ActiveBackupJob,
    recordBackupNeedsAttention,
    trimBackupOutput,
} from "./backupJobs.ts";

export interface BackupAbortConfig {
    container: string;
    processPattern: string;
}

const CONTAINER_PGREP_NO_MATCH_MARKER = "__MIRA_CONTAINER_PGREP_NO_MATCH__";
const backupAbortContainerWaitMs = 30_000;
const backupAbortContainerPollMs = 1000;
const backupAbortContainerConfirmAttempts = 3;
const backupAbortDockerExecTimeoutMs = 5000;

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

export async function assertNoContainerBackupInProgress(
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

export async function assertNoHostBackupInProgress(
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

export async function waitForContainerProcessExitWithRetries(
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

export async function waitForHostProcessExitWithRetries(
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

export async function terminateContainerProcessSafely(
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
