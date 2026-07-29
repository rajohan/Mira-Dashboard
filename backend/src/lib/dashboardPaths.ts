import path from "node:path";

import { resolveAbsoluteNonRootPath } from "./safePath.ts";

const FALLBACK_DASHBOARD_PROJECT_ROOT = "/home/ubuntu/projects/mira-dashboard";

export interface DashboardProjectPaths {
    developmentLocalStateRoot: string;
    developmentPreviewRoot: string;
    developmentPreviewStateRoot: string;
    developmentRoot: string;
    developmentWorktreeRoot: string;
    productionCheckoutRoot: string;
    productionDatabasePath: string;
    productionLogRotationLockFile: string;
    productionOpenClawHome: string;
    productionReleasesRoot: string;
    productionRoot: string;
    productionStateRoot: string;
    projectRoot: string;
}

export function dashboardProjectPaths(projectRoot: string): DashboardProjectPaths {
    const root = resolveAbsoluteNonRootPath(projectRoot, "Dashboard project root");
    const productionRoot = path.join(root, "production");
    const productionStateRoot = path.join(productionRoot, "state");
    const developmentRoot = path.join(root, "development");
    return {
        developmentLocalStateRoot: path.join(developmentRoot, "state", "local"),
        developmentPreviewRoot: path.join(developmentRoot, "preview"),
        developmentPreviewStateRoot: path.join(developmentRoot, "state", "preview"),
        developmentRoot,
        developmentWorktreeRoot: path.join(developmentRoot, "worktrees"),
        productionCheckoutRoot: path.join(productionRoot, "checkout"),
        productionDatabasePath: path.join(productionStateRoot, "mira-dashboard.db"),
        productionLogRotationLockFile: path.join(
            productionStateRoot,
            "log-rotation.lock"
        ),
        productionOpenClawHome: path.join(productionStateRoot, "openclaw-client"),
        productionReleasesRoot: path.join(productionRoot, "releases"),
        productionRoot,
        productionStateRoot,
        projectRoot: root,
    };
}

export function configuredDashboardProjectPaths(
    environment: NodeJS.ProcessEnv = process.env
): DashboardProjectPaths | undefined {
    const configuredRoot = environment.MIRA_DASHBOARD_PROJECT_ROOT?.trim();
    return configuredRoot ? dashboardProjectPaths(configuredRoot) : undefined;
}

export function resolveDashboardProjectPaths(
    environment: NodeJS.ProcessEnv = process.env
): DashboardProjectPaths {
    return dashboardProjectPaths(
        environment.MIRA_DASHBOARD_PROJECT_ROOT?.trim() || FALLBACK_DASHBOARD_PROJECT_ROOT
    );
}

export function resolveDashboardProjectPathsForRuntime(
    environment: NodeJS.ProcessEnv = process.env
): DashboardProjectPaths | undefined {
    return (
        configuredDashboardProjectPaths(environment) ??
        (environment.NODE_ENV === "production"
            ? resolveDashboardProjectPaths(environment)
            : undefined)
    );
}

/**
 * Keeps the production layout immutable while allowing isolated development
 * children and tests to inject process-specific paths.
 * @param derivedPath Derived path value.
 * @param internalOverride Internal override value.
 * @param environment Environment value.
 * @returns Resolve dashboard runtime path result.
 */
export function resolveDashboardRuntimePath(
    derivedPath: string | undefined,
    internalOverride: string | undefined,
    environment: NodeJS.ProcessEnv = process.env
): string | undefined {
    const override = internalOverride?.trim() || undefined;
    return environment.NODE_ENV === "production" ? derivedPath : override || derivedPath;
}
