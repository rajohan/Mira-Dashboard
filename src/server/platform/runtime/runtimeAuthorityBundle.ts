import * as v from "valibot";

import { serviceActionIds } from "../../../contracts/serviceActions.ts";
import { dashboardRouteDocumentation } from "../../../shared/browserRouteRegistry.ts";
import { cacheProviderDefinitions } from "../../domains/cache/providerRegistry.ts";
import {
    backupClearAttentionJobActionDefinition,
    deliveryGitHubJobActionDefinition,
    deliveryPreviewJobActionDefinition,
    deliveryProductionJobActionDefinition,
    dockerOperationJobActionDefinition,
    hostSystemCleanupJobActionDefinition,
    hostDashboardRestartJobActionDefinition,
    hostSystemRestartJobActionDefinition,
    hostSystemUpdateJobActionDefinition,
    hostWorkerRestartJobActionDefinition,
    jobActionDefinitions,
    openClawGatewayRestartJobActionDefinition,
    openClawInstallationUpdateJobActionDefinition,
    openClawSessionsCleanupJobActionDefinition,
    workspaceFileReplaceJobActionDefinition,
    workspaceFileWriteJobActionDefinition,
} from "../../domains/jobs/actionRegistry.ts";
import {
    sourceDevelopmentExecutableJobActionDefinitions,
    sourceDevelopmentScheduledJobActionDefinitions,
} from "../../domains/jobs/sourceDevelopmentActionComposition.ts";
import { appRouterProcedureNames } from "../../trpc/appRouter.ts";

export const sourceDevelopmentAuthorityModes = Object.freeze([
    "isolated",
    "live-read",
    "simulated",
] as const);
export type SourceDevelopmentAuthorityMode =
    (typeof sourceDevelopmentAuthorityModes)[number];

/** Coarse production capabilities that must receive one explicit dev disposition. */
export const productionCapabilityIds = Object.freeze([
    "backup-operations",
    "dashboard-state",
    "database-observability",
    "delivery-operations",
    "docker-operations",
    "gateway-events",
    "gateway-mutations",
    "gateway-reads",
    "host-observability",
    "moltbook-reads",
    "service-actions",
    "terminal",
    "workspace-files",
] as const);
export type ProductionCapabilityId = (typeof productionCapabilityIds)[number];

interface RuntimeInventory {
    readonly actions: readonly string[];
    readonly cacheProviders: readonly string[];
    readonly procedures: readonly string[];
    readonly routes: readonly string[];
    readonly scheduledActions: readonly string[];
    readonly serviceActions: readonly string[];
}

interface ProductionAuthorityBundle {
    readonly capabilities: Readonly<Record<ProductionCapabilityId, "production">>;
    readonly inventory: RuntimeInventory;
    readonly profile: "production";
}

interface SourceDevelopmentAuthorityBundle {
    readonly capabilities: Readonly<
        Record<ProductionCapabilityId, SourceDevelopmentAuthorityMode>
    >;
    readonly inventory: RuntimeInventory;
    readonly profile: "source-development";
}

const productionExecutableActionDefinitions = Object.freeze([
    ...jobActionDefinitions,
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
]);

function inventory(input: {
    readonly actions: readonly string[];
    readonly scheduledActions: readonly string[];
}): RuntimeInventory {
    return Object.freeze({
        actions: Object.freeze([...input.actions]),
        cacheProviders: Object.freeze(cacheProviderDefinitions.map(({ key }) => key)),
        procedures: Object.freeze([...appRouterProcedureNames]),
        routes: Object.freeze(dashboardRouteDocumentation.map(({ path }) => path)),
        scheduledActions: Object.freeze([...input.scheduledActions]),
        serviceActions: Object.freeze([...serviceActionIds]),
    });
}

export const productionAuthorityBundle = Object.freeze({
    capabilities: Object.freeze(
        Object.fromEntries(
            productionCapabilityIds.map((capability) => [capability, "production"])
        ) as Record<ProductionCapabilityId, "production">
    ),
    inventory: inventory({
        actions: productionExecutableActionDefinitions.map(({ actionKey }) => actionKey),
        scheduledActions: jobActionDefinitions.map(({ actionKey }) => actionKey),
    }),
    profile: "production",
}) satisfies ProductionAuthorityBundle;

export const sourceDevelopmentAuthorityBundle = Object.freeze({
    capabilities: Object.freeze({
        "backup-operations": "simulated",
        "dashboard-state": "isolated",
        "database-observability": "simulated",
        "delivery-operations": "simulated",
        "docker-operations": "simulated",
        "gateway-events": "live-read",
        "gateway-mutations": "simulated",
        "gateway-reads": "live-read",
        "host-observability": "live-read",
        "moltbook-reads": "live-read",
        "service-actions": "simulated",
        terminal: "isolated",
        "workspace-files": "isolated",
    }),
    inventory: inventory({
        actions: sourceDevelopmentExecutableJobActionDefinitions.map(
            ({ actionKey }) => actionKey
        ),
        scheduledActions: sourceDevelopmentScheduledJobActionDefinitions.map(
            ({ actionKey }) => actionKey
        ),
    }),
    profile: "source-development",
}) satisfies SourceDevelopmentAuthorityBundle;

const authorityModeSchema = v.picklist(sourceDevelopmentAuthorityModes);

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return (
        left.length === right.length &&
        left.every((value, index) => value === right[index])
    );
}

/**
 * Machine-verifiable structural parity gate. Browser routes, procedures, cache
 * contracts, Service Actions, schedules, and action definitions remain identical.
 * Each production capability receives one reviewed development disposition while
 * provider authority is replaced behind the unchanged runtime inventory.
 */
export function assertSourceDevelopmentAuthorityParity(): void {
    const production = productionAuthorityBundle;
    const development = sourceDevelopmentAuthorityBundle;
    for (const capability of productionCapabilityIds) {
        v.parse(authorityModeSchema, development.capabilities[capability]);
    }
    const exactInventories = [
        [production.inventory.routes, development.inventory.routes],
        [production.inventory.procedures, development.inventory.procedures],
        [production.inventory.cacheProviders, development.inventory.cacheProviders],
        [production.inventory.serviceActions, development.inventory.serviceActions],
        [production.inventory.actions, development.inventory.actions],
        [production.inventory.scheduledActions, development.inventory.scheduledActions],
    ] as const;
    if (
        exactInventories.some(([left, right]) => !arraysEqual(left, right)) ||
        new Set(production.inventory.actions).size !==
            production.inventory.actions.length ||
        new Set(development.inventory.actions).size !==
            development.inventory.actions.length ||
        development.inventory.scheduledActions.some(
            (actionKey) => !development.inventory.actions.includes(actionKey)
        )
    ) {
        throw new Error("Source-development authority parity is invalid");
    }
}

assertSourceDevelopmentAuthorityParity();
