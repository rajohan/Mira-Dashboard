import type {
    BackupJob as BackupJobResponse,
    BackupJobStatus,
    BackupType,
} from "../../../../contracts/backups.ts";
import { errorMessage } from "../../lib/errors.ts";
import type { BunProcess } from "../../lib/processes.ts";
import { refreshCacheProducer } from "../cacheRefresh/cacheRefreshRuntime.ts";

const MAX_OUTPUT_CHARS = 100_000;

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

export const backupJobs = new Map<string, ActiveBackupJob>();
export const backupRouteState: {
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
export function getCurrentKopiaJob() {
    return getCurrentJob(backupRouteState.activeKopiaJobId, () => {
        backupRouteState.activeKopiaJobId = undefined;
    });
}

/**
 * Returns current walg job.
 * @returns current walg job.
 */
export function getCurrentWalgJob() {
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

export function evictCompletedBackupJobs(type: BackupType) {
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

export function recordBackupNeedsAttention(
    type: BackupType,
    stderr: string
): ActiveBackupJob {
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

export async function refreshBackupStatus(
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

export function getCurrentBackupJob(type: BackupType): ActiveBackupJob | undefined {
    return (type === "kopia" ? getCurrentKopiaJob : getCurrentWalgJob)();
}
