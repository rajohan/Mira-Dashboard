import path from "node:path";

import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";

export const DASHBOARD_REPO = "rajohan/Mira-Dashboard";
export const DASHBOARD_SERVICES = [
    "mira-dashboard.service",
    "mira-dashboard-worker.service",
] as const;
export const DEFAULT_REVIEWER_AUTHOR = "rajohan";
export const DEFAULT_BASE = "main";

function resolveConfiguredRoot(environmentName: string, fallback: string): string {
    const rawValue = nonEmptyEnvironmentFallback(environmentName, fallback).trim();
    if (!path.isAbsolute(rawValue)) {
        throw new Error(`${environmentName} must be an absolute non-root path`);
    }
    const value = path.resolve(rawValue);
    if (value === path.parse(value).root) {
        throw new Error(`${environmentName} must be an absolute non-root path`);
    }
    return value;
}

export function getDashboardRoot(): string {
    return process.env.NODE_ENV === "production"
        ? resolveDashboardProjectPaths().productionCheckoutRoot
        : resolveConfiguredRoot(
              "MIRA_DASHBOARD_ROOT",
              resolveDashboardProjectPaths().productionCheckoutRoot
          );
}

export function getDashboardWorktreeRoot(): string {
    return process.env.NODE_ENV === "production"
        ? resolveDashboardProjectPaths().developmentWorktreeRoot
        : resolveConfiguredRoot(
              "MIRA_DASHBOARD_WORKTREE_ROOT",
              resolveDashboardProjectPaths().developmentWorktreeRoot
          );
}

export function getResolvedRoots() {
    return {
        dashboardRoot: getDashboardRoot(),
        dashboardWorktreeRoot: getDashboardWorktreeRoot(),
    };
}
