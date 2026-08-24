/** Complete contract-ordered inventory of reviewed privileged host operations. */
export const hostOperationIds = Object.freeze([
    "system-cleanup",
    "system-restart",
    "system-update",
] as const);

/** One exact reviewed privileged host operation. */
export type HostOperationId = (typeof hostOperationIds)[number];

/** Fixed root-owned systemd units implementing the reviewed host operations. */
export const fixedHostOperationUnits: Readonly<Record<HostOperationId, string>> =
    Object.freeze({
        "system-cleanup": "mira-dashboard-host-system-cleanup.service",
        "system-restart": "mira-dashboard-host-system-restart.service",
        "system-update": "mira-dashboard-host-system-update.service",
    });
