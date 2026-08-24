/** Browser routes currently owned by the greenfield Dashboard. */
export const dashboardRoutePaths = Object.freeze([
    "/",
    "/account-security",
    "/agents",
    "/login",
    "/tasks",
] as const);

export type DashboardRoutePath = (typeof dashboardRoutePaths)[number];

/** Routes shown inside the authenticated application navigation. */
export type DashboardNavigationPath = Exclude<DashboardRoutePath, "/login">;
