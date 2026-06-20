export function shouldStartScheduledJobs(
    environment: Record<string, string | undefined> = process.env
): boolean {
    return environment.MIRA_DASHBOARD_DISABLE_SCHEDULER !== "1";
}
