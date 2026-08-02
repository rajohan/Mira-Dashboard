import type { BackupType } from "../../../../contracts/backups.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { refreshCacheProducer } from "../cacheRefresh/cacheRefreshRuntime.ts";
import {
    type ActiveBackupJob,
    backupStatusCacheKey,
    getCurrentBackupJob,
    getCurrentKopiaJob,
    getCurrentWalgJob,
} from "./backupJobs.ts";
import {
    assertNoContainerBackupInProgress,
    assertNoHostBackupInProgress,
} from "./backupProcessControl.ts";
import { startBackupJob } from "./backupRunner.ts";

const logger = createStructuredLogger("backups");
const KOPIA_BACKUP_SCRIPT_PATTERN = "/opt/docker/apps/kopia/backup.sh";
const WALG_BACKUP_SCRIPT_PATTERN = "/usr/local/bin/backup-push.sh";

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
