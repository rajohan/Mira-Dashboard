/** Exact unit artifacts admitted into one immutable Dashboard release. */
export const productionSystemdUnits = Object.freeze([
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-deferred-reboot.service",
        fileName: "mira-dashboard-deferred-reboot.service",
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-deferred-reboot.timer",
        fileName: "mira-dashboard-deferred-reboot.timer",
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-stack-restart.service",
        fileName: "mira-dashboard-deferred-stack-restart.service",
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-stack-restart.timer",
        fileName: "mira-dashboard-deferred-stack-restart.timer",
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-worker-restart.service",
        fileName: "mira-dashboard-deferred-worker-restart.service",
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-deferred-worker-restart.timer",
        fileName: "mira-dashboard-deferred-worker-restart.timer",
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-host-system-cleanup.service",
        fileName: "mira-dashboard-host-system-cleanup.service",
    }),
    Object.freeze({
        artifactPath:
            "systemd/host-operations/mira-dashboard-host-system-restart.service",
        fileName: "mira-dashboard-host-system-restart.service",
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-host-system-update.service",
        fileName: "mira-dashboard-host-system-update.service",
    }),
    Object.freeze({
        artifactPath: "systemd/host-operations/mira-dashboard-provision@.service",
        fileName: "mira-dashboard-provision@.service",
    }),
    Object.freeze({
        artifactPath: "systemd/log-maintenance/mira-dashboard-log-maintenance@.service",
        fileName: "mira-dashboard-log-maintenance@.service",
    }),
    Object.freeze({
        artifactPath: "systemd/mira-dashboard-web.service",
        fileName: "mira-dashboard-web.service",
    }),
    Object.freeze({
        artifactPath: "systemd/mira-dashboard-worker.service",
        fileName: "mira-dashboard-worker.service",
    }),
] as const);

/** Current host-native project location represented by the reviewed unit sources. */
export const productionProjectHomeRelativePath = "projects/mira-dashboard";
