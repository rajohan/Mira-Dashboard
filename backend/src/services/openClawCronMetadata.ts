import { database } from "../database.ts";
import { type JobDisableIntent, parseJobDisableIntent } from "./jobDisableIntent.ts";

interface OpenClawCronJobMetadataRow {
    job_id: string;
    disable_intent_json: string;
}

/** Reads one OpenClaw cron annotation for compensated writes. */
export function getOpenClawCronDisableIntent(
    jobId: string
): JobDisableIntent | undefined {
    const row = database
        .prepare(
            `SELECT job_id, disable_intent_json
             FROM openclaw_cron_job_metadata
             WHERE job_id = ?`
        )
        .get(jobId) as OpenClawCronJobMetadataRow | undefined;
    return parseJobDisableIntent(row?.disable_intent_json);
}

/** Reads intentional-disable metadata keyed by the external OpenClaw cron ID. */
export function openClawCronDisableIntentsByJobId(): Map<string, JobDisableIntent> {
    const rows = database
        .prepare("SELECT job_id, disable_intent_json FROM openclaw_cron_job_metadata")
        .all() as unknown as OpenClawCronJobMetadataRow[];
    return new Map(
        rows.flatMap((row) => {
            const intent = parseJobDisableIntent(row.disable_intent_json);
            return intent ? ([[row.job_id, intent]] as const) : [];
        })
    );
}

/** Stores an active annotation, or removes it when the cron is enabled again. */
export function setOpenClawCronDisableIntent(
    jobId: string,
    intent: JobDisableIntent | undefined
): void {
    if (!intent) {
        database
            .prepare("DELETE FROM openclaw_cron_job_metadata WHERE job_id = ?")
            .run(jobId);
        return;
    }
    const timestamp = new Date().toISOString();
    database
        .prepare(
            `INSERT INTO openclaw_cron_job_metadata (
                job_id, disable_intent_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(job_id) DO UPDATE SET
                disable_intent_json = excluded.disable_intent_json,
                updated_at = excluded.updated_at`
        )
        .run(jobId, JSON.stringify(intent), timestamp, timestamp);
}
