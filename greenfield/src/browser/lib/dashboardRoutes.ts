import { dashboardRouteDocumentation } from "../../shared/browserRouteRegistry.ts";

export {
    dashboardRouteDocumentation,
    type DashboardRouteDocumentation,
} from "../../shared/browserRouteRegistry.ts";

/** Browser routes currently owned by the greenfield Dashboard. */
export const dashboardRoutePaths = Object.freeze(
    dashboardRouteDocumentation.map(({ path }) => path)
);

export type DashboardRoutePath = (typeof dashboardRoutePaths)[number];

/** Routes rendered only inside an authenticated application shell. */
export type DashboardAuthenticatedPath = Exclude<DashboardRoutePath, "/login">;

/** Authenticated routes shown in the main application navigation. */
export type DashboardNavigationPath = Exclude<DashboardAuthenticatedPath, "/incidents">;
