import { json } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    clearPersistedBackupAttention,
    getPersistedBackupJob,
    queueManualBackup,
} from "../services/backups.ts";

type BackupType = "kopia" | "walg";

function backupResponseError(error: unknown, fallback: string): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

function backupStatus(type: BackupType): Response {
    return json({ job: getPersistedBackupJob(type) });
}

async function runBackup(type: BackupType, fallback: string): Promise<Response> {
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
