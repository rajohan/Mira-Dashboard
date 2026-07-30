export const MANAGED_DASHBOARD_UNITS = {
    "mira-dashboard-worker.service": "dist/workerStart.js",
    "mira-dashboard.service": "dist/serverStart.js",
} as const;

export type ManagedDashboardUnitName = keyof typeof MANAGED_DASHBOARD_UNITS;

export const MANAGED_DASHBOARD_UNIT_NAMES = Object.keys(
    MANAGED_DASHBOARD_UNITS
) as ManagedDashboardUnitName[];

export const MANAGED_DASHBOARD_UNIT_ARTIFACTS = MANAGED_DASHBOARD_UNIT_NAMES.map(
    (unit) => `systemd/${unit}` as const
);

export const MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT = [
    "NODE_ENV",
    "MIRA_DASHBOARD_PROJECT_ROOT",
] as const;

export const MANAGED_DASHBOARD_UNIT_POLICY_ENVIRONMENT = {
    "mira-dashboard-worker.service": ["NODE_ENV=production"],
    "mira-dashboard.service": ["NODE_ENV=production"],
} as const satisfies Record<ManagedDashboardUnitName, readonly string[]>;
