import {
    backupClearAttentionJobActionDefinition,
    deliveryGitHubJobActionDefinition,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
    dockerOperationJobActionDefinition,
    hostDashboardRestartJobActionDefinition,
    hostSystemCleanupJobActionDefinition,
    hostSystemRestartJobActionDefinition,
    hostSystemUpdateJobActionDefinition,
    hostWorkerRestartJobActionDefinition,
    jobActionDefinitions,
    openClawGatewayRestartJobActionDefinition,
    openClawInstallationUpdateJobActionDefinition,
    openClawSessionsCleanupJobActionDefinition,
    type JobActionDefinition,
    type JobExecutableActionDefinition,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileWriteJobActionDefinition,
} from "./actionRegistry.ts";

/**
 * Exact schedule inventory shared by the source-development web and worker roots.
 * Ordinary source development uses development-only providers for every production
 * schedule; managed previews select their separate smoke-only inventory upstream.
 */
export const sourceDevelopmentScheduledJobActionDefinitions = Object.freeze([
    ...jobActionDefinitions,
]) satisfies readonly JobActionDefinition[];

/**
 * Complete executable inventory for the ordinary source-development worker.
 * Unscheduled file actions are confined to marked development roots. Privileged
 * Service Actions are backed by explicit simulators rather than host/Gateway ports.
 */
export const sourceDevelopmentExecutableJobActionDefinitions = Object.freeze([
    ...sourceDevelopmentScheduledJobActionDefinitions,
    workspaceFileWriteJobActionDefinition,
    workspaceFileReplaceJobActionDefinition,
    openClawGatewayRestartJobActionDefinition,
    openClawSessionsCleanupJobActionDefinition,
    openClawInstallationUpdateJobActionDefinition,
    hostDashboardRestartJobActionDefinition,
    hostSystemCleanupJobActionDefinition,
    hostSystemRestartJobActionDefinition,
    hostSystemUpdateJobActionDefinition,
    hostWorkerRestartJobActionDefinition,
    dockerOperationJobActionDefinition,
    backupClearAttentionJobActionDefinition,
    deliveryGitHubJobActionDefinition,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
]) satisfies readonly JobExecutableActionDefinition[];

function actionKeys(
    definitions: readonly JobExecutableActionDefinition[]
): readonly string[] {
    return definitions.map(({ actionKey }) => actionKey);
}

/**
 * Fail closed when the advertised schedule inventory and the executable worker
 * inventory diverge. The worker resolver independently requires an executor for
 * every definition during runtime initialization.
 */
export function assertSourceDevelopmentActionComposition(): void {
    const advertisedKeys = actionKeys(sourceDevelopmentScheduledJobActionDefinitions);
    const executableKeys = actionKeys(sourceDevelopmentExecutableJobActionDefinitions);
    if (
        advertisedKeys.length !== jobActionDefinitions.length ||
        !advertisedKeys.every(
            (actionKey, index) => actionKey === jobActionDefinitions[index]?.actionKey
        ) ||
        new Set(executableKeys).size !== executableKeys.length ||
        advertisedKeys.some((actionKey) => !executableKeys.includes(actionKey))
    ) {
        throw new Error("Source-development Job action composition is invalid");
    }
}

assertSourceDevelopmentActionComposition();
