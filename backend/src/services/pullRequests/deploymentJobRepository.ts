import type { DeploymentJob } from "../../../../contracts/delivery/deployments.ts";
import { database, sqlNullable } from "../../database/connection.ts";
import { dashboardCommitUrl } from "./support.ts";

const RECENT_DEPLOYMENTS_LIMIT = 10;

export function writeDeploymentJob(job: DeploymentJob): void {
    database
        .prepare(
            `
        INSERT INTO deployment_jobs (
            id,
            status,
            started_at,
            updated_at,
            commit_sha,
            commit_title,
            note,
            stdout,
            stderr
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            commit_sha = excluded.commit_sha,
            commit_title = excluded.commit_title,
            note = excluded.note,
            stdout = excluded.stdout,
            stderr = excluded.stderr
        `
        )
        .run(
            job.id,
            job.status,
            job.startedAt,
            job.updatedAt,
            sqlNullable(job.commit ?? undefined),
            sqlNullable(job.commitTitle ?? undefined),
            sqlNullable(job.note ?? undefined),
            sqlNullable(job.stdout ?? undefined),
            sqlNullable(job.stderr ?? undefined)
        );
}

interface DeploymentJobRow {
    id: string;
    status: DeploymentJob["status"];
    started_at: string;
    updated_at: string;
    commit_sha: string | null;
    commit_title: string | null;
    note: string | null;
    stdout: string | null;
    stderr: string | null;
}

function mapDeploymentJob(row: DeploymentJobRow): DeploymentJob {
    const commit = row.commit_sha ?? undefined;
    return {
        id: row.id,
        status: row.status,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        commit,
        commitTitle: row.commit_title ?? undefined,
        commitUrl: commit ? dashboardCommitUrl(commit) : undefined,
        note: row.note ?? undefined,
        stdout: row.stdout ?? undefined,
        stderr: row.stderr ?? undefined,
    };
}

/**
 * Reads one deployment job.
 * @param jobId Job identifier.
 * @returns Read one deployment job.
 */
export function readDeploymentJob(jobId: string): DeploymentJob | undefined {
    const row = database
        .prepare(
            `
            SELECT
                id,
                status,
                started_at,
                updated_at,
                commit_sha,
                commit_title,
                note,
                stdout,
                stderr
            FROM deployment_jobs
            WHERE id = ?
            `
        )
        .get(jobId) as DeploymentJobRow | undefined;
    return row ? mapDeploymentJob(row) : undefined;
}

/**
 * Performs read deployment jobs.
 * @returns Read deployment jobs result.
 */
export function readDeploymentJobs(): DeploymentJob[] {
    return (
        database
            .prepare(
                `
                SELECT
                    id,
                    status,
                    started_at,
                    updated_at,
                    commit_sha,
                    commit_title,
                    note,
                    stdout,
                    stderr
                FROM deployment_jobs
                ORDER BY updated_at DESC
                LIMIT ?
                `
            )
            .all(RECENT_DEPLOYMENTS_LIMIT) as unknown as DeploymentJobRow[]
    ).map((row) => mapDeploymentJob(row));
}
