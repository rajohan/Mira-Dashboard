import { json } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    clearNeedsAttentionBackupJob,
    getCurrentBackupJob,
    mapBackupJob,
    startManualBackup,
} from "../services/backups.ts";

type BackupType = "kopia" | "walg";

function backupResponseError(error: unknown, fallback: string): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

function backupStatus(type: BackupType): Response {
    return json({ job: mapBackupJob(getCurrentBackupJob(type)) });
}

async function runBackup(type: BackupType, fallback: string): Promise<Response> {
    try {
        const job = await startManualBackup(type);
        return json({ isOk: true, job: mapBackupJob(job) });
    } catch (error) {
        return backupResponseError(error, fallback);
    }
}

async function clearNeedsAttention(
    type: BackupType,
    fallback: string
): Promise<Response> {
    try {
        const job = await clearNeedsAttentionBackupJob(type);
        return json({ cleared: mapBackupJob(job), isOk: true });
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
