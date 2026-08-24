/** Browser routes currently owned by the greenfield Dashboard. */
export const dashboardRoutePaths = Object.freeze([
    "/",
    "/account-security",
    "/agents",
    "/incidents",
    "/jobs",
    "/login",
    "/reports",
    "/sessions",
    "/tasks",
] as const);

export type DashboardRoutePath = (typeof dashboardRoutePaths)[number];

/** Routes rendered only inside an authenticated application shell. */
export type DashboardAuthenticatedPath = Exclude<DashboardRoutePath, "/login">;

/** Authenticated routes shown in the main application navigation. */
export type DashboardNavigationPath = Exclude<DashboardAuthenticatedPath, "/incidents">;
