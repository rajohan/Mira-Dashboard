export type DashboardExecutionRole = "combined" | "web" | "worker";

export function dashboardExecutionRole(
    environment: Record<string, string | undefined> = process.env
): DashboardExecutionRole {
    const role = environment.MIRA_DASHBOARD_EXECUTION_ROLE?.trim();
    return role === "web" || role === "worker" ? role : "combined";
}

export function shouldStartScheduledJobs(
    environment: Record<string, string | undefined> = process.env
): boolean {
    return (
        environment.MIRA_DASHBOARD_DISABLE_SCHEDULER !== "1" &&
        dashboardExecutionRole(environment) !== "web"
    );
}
