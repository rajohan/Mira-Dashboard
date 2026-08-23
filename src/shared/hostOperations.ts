/** Complete contract-ordered inventory of reviewed privileged host operations. */
export const hostOperationIds = Object.freeze([
    "dashboard-restart",
    "dashboard-stack-restart",
    "system-cleanup",
    "system-restart",
    "system-update",
    "worker-restart",
] as const);

/** One exact reviewed privileged host operation. */
export type HostOperationId = (typeof hostOperationIds)[number];

/** Fixed root-owned systemd units implementing the reviewed host operations. */
export const fixedHostOperationUnits: Readonly<
    Record<HostOperationId, readonly string[]>
> = Object.freeze({
    "dashboard-restart": Object.freeze(["mira-dashboard-web.service"]),
    "dashboard-stack-restart": Object.freeze([
        "mira-dashboard-deferred-stack-restart.timer",
    ]),
    "system-cleanup": Object.freeze(["mira-dashboard-host-system-cleanup.service"]),
    "system-restart": Object.freeze(["mira-dashboard-host-system-restart.service"]),
    "system-update": Object.freeze(["mira-dashboard-host-system-update.service"]),
    "worker-restart": Object.freeze(["mira-dashboard-deferred-worker-restart.timer"]),
});
