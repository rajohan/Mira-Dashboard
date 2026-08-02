import type { BackupType } from "../../../contracts/backups.ts";
import { json } from "../http/core.ts";
import { routeErrorResponse } from "../http/routeSupport.ts";
import {
    clearPersistedBackupAttention,
    getPersistedBackupJob,
    queueManualBackup,
} from "../services/backups/scheduling.ts";

function backupResponseError(error: unknown, fallback: string): Response {
    return routeErrorResponse(undefined, error, {
        code: "backup_request_failed",
        context: "backup",
        message: fallback,
    });
}

function backupStatus(type: BackupType): Response {
    return json({ job: getPersistedBackupJob(type) });
}

function runBackup(type: BackupType, fallback: string): Response {
    try {
        return json({ isOk: true, job: queueManualBackup(type) });
    } catch (error) {
        return backupResponseError(error, fallback);
    }
}

async function clearNeedsAttention(
    type: BackupType,
    fallback: string
): Promise<Response> {
    try {
        const job = await clearPersistedBackupAttention(type);
        return json({ cleared: job, isOk: true });
    } catch (error) {
        return backupResponseError(error, fallback);
    }
}

export const backupRoutes = {
    "/api/backups/kopia": {
        GET: () => backupStatus("kopia"),
    },
    "/api/backups/kopia/clear-needs-attention": {
        POST: () =>
            clearNeedsAttention("kopia", "Failed to clear Kopia backup attention"),
    },
    "/api/backups/kopia/run": {
        POST: () => runBackup("kopia", "Failed to start Kopia backup"),
    },
    "/api/backups/walg": {
        GET: () => backupStatus("walg"),
    },
    "/api/backups/walg/clear-needs-attention": {
        POST: () => clearNeedsAttention("walg", "Failed to clear WAL-G backup attention"),
    },
    "/api/backups/walg/run": {
        POST: () => runBackup("walg", "Failed to start WAL-G backup"),
    },
} as const;
