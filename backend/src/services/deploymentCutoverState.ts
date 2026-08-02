import { database } from "../database/connection.ts";

/**
 * Keeps production writes paused while a detached release guardian owns cutover.
 * @returns Whether production deployment cutover is active.
 */
export function isProductionDeploymentCutoverActive(
    environment: Record<string, string | undefined> = process.env
): boolean {
    if (environment.NODE_ENV !== "production") {
        return false;
    }
    // The retained deployment history is capped at 500 rows. This bounded,
    // fail-closed read deliberately avoids a process-local cache that a detached
    // guardian could leave stale while it changes the deployment state.
    return Boolean(
        database
            .query(
                `SELECT 1
                 FROM deployment_jobs
                 WHERE status = 'verifying'
                 LIMIT 1`
            )
            .get()
    );
}
