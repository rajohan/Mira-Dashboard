import { database } from "../database.ts";

/** Keeps production writes paused while a detached release guardian owns cutover. */
export function isProductionDeploymentCutoverActive(
    environment: Record<string, string | undefined> = process.env
): boolean {
    if (environment.NODE_ENV !== "production") {
        return false;
    }
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
