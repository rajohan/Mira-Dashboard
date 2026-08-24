/** Exact unit artifacts admitted into one immutable Dashboard release. */
export const productionSystemdUnits = Object.freeze([
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
