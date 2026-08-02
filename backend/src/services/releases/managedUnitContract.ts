import path from "node:path";

import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { resolveAbsoluteNonRootPath } from "../../lib/safePath.ts";
import { parseSystemdProperties } from "../../lib/systemdProperties.ts";
import { resolveDashboardReleasesRoot } from "./releaseLayout.ts";
import {
    MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT,
    MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT,
    MANAGED_DASHBOARD_UNIT_POLICY_ENVIRONMENT,
    MANAGED_DASHBOARD_UNITS,
    type ManagedDashboardUnitName,
} from "./systemdPolicy.ts";

export interface ManagedDashboardUnitContract {
    databasePath: string;
    logRotationLockFile: string;
    openClawHome: string;
    previewRoot: string;
    previewWorktreePath: string;
    projectRoot: string;
    releaseRoot: string;
    releasesRoot: string;
    runtimeLauncher: string;
    sourceRoot: string;
    worktreeRoot: string;
}

function hasExactEnvironmentAssignment(
    serializedEnvironment: string,
    assignment: string
): boolean {
    const escaped = assignment.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    return new RegExp(String.raw`(?:^|[\s"])${escaped}(?=$|[\s"])`, "u").test(
        serializedEnvironment
    );
}

function hasExactSerializedToken(serializedValue: string, token: string): boolean {
    const escaped = token.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    return new RegExp(String.raw`(?:^|[\s";])${escaped}(?=$|[\s";])`, "u").test(
        serializedValue
    );
}

export function managedDashboardUnitContract(
    releasesRoot = resolveDashboardReleasesRoot()
): ManagedDashboardUnitContract {
    const projectPaths = resolveDashboardProjectPaths();
    const root = resolveAbsoluteNonRootPath(releasesRoot, "Dashboard releases root");
    return {
        databasePath: resolveAbsoluteNonRootPath(
            projectPaths.productionDatabasePath,
            "Dashboard database path"
        ),
        logRotationLockFile: resolveAbsoluteNonRootPath(
            projectPaths.productionLogRotationLockFile,
            "Dashboard log rotation lock file"
        ),
        openClawHome: resolveAbsoluteNonRootPath(
            projectPaths.productionOpenClawHome,
            "Dashboard OpenClaw home"
        ),
        previewRoot: resolveAbsoluteNonRootPath(
            projectPaths.developmentPreviewStateRoot,
            "Dashboard preview state root"
        ),
        previewWorktreePath: resolveAbsoluteNonRootPath(
            projectPaths.developmentPreviewRoot,
            "Dashboard preview worktree path"
        ),
        projectRoot: projectPaths.projectRoot,
        releaseRoot: path.join(root, "current"),
        releasesRoot: root,
        runtimeLauncher: path.join(
            root,
            "current",
            MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT
        ),
        sourceRoot: resolveAbsoluteNonRootPath(
            projectPaths.productionCheckoutRoot,
            "Dashboard source root"
        ),
        worktreeRoot: resolveAbsoluteNonRootPath(
            projectPaths.developmentWorktreeRoot,
            "Dashboard worktree root"
        ),
    };
}

export function assertManagedDashboardUnitProperties(
    unit: ManagedDashboardUnitName,
    properties: string,
    contract = managedDashboardUnitContract()
): void {
    const expectedEnvironment = [
        ...MANAGED_DASHBOARD_UNIT_POLICY_ENVIRONMENT[unit],
        `MIRA_DASHBOARD_PROJECT_ROOT=${contract.projectRoot}`,
    ];
    const expectedWorkingDirectory = `${contract.releaseRoot}/backend`;
    const actual = parseSystemdProperties(properties);
    if (actual.get("WorkingDirectory") !== expectedWorkingDirectory) {
        throw new Error(
            `${unit} must run from managed current/backend before Dashboard deployment`
        );
    }
    const execStart = actual.get("ExecStart") ?? "";
    if (!hasExactSerializedToken(execStart, contract.runtimeLauncher)) {
        throw new Error(`${unit} must use the managed Bun runtime launcher`);
    }
    if (!hasExactSerializedToken(execStart, MANAGED_DASHBOARD_UNITS[unit])) {
        throw new Error(`${unit} has an unexpected managed release entrypoint`);
    }
    const preservedEnvironment = `--preserve-env=${MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT.join(
        ","
    )}`;
    if (!hasExactSerializedToken(execStart, preservedEnvironment)) {
        throw new Error(
            `${unit} must preserve managed release environment through Doppler`
        );
    }
    const environment = actual.get("Environment") ?? "";
    const missingEnvironment = expectedEnvironment.filter(
        (entry) => !hasExactEnvironmentAssignment(environment, entry)
    );
    if (missingEnvironment.length > 0) {
        throw new Error(
            `${unit} is missing stable managed release environment: ${missingEnvironment
                .map((entry) => entry.slice(0, entry.indexOf("=")))
                .join(", ")}`
        );
    }
}
