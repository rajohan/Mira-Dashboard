export const DASHBOARD_AUTOMATION_PROFILES = {
    "daily-brief": {
        fileName: "openclaw-daily-brief.token",
        id: "openclaw-daily-brief",
        scopes: ["cache:read", "reports:write", "tasks:read"],
    },
    "daily-summary": {
        fileName: "openclaw-daily-summary.token",
        id: "openclaw-daily-summary",
        scopes: ["cache:read", "reports:write"],
    },
    heartbeat: {
        fileName: "openclaw-heartbeat.token",
        id: "openclaw-heartbeat",
        scopes: ["cache:read", "reports:write"],
    },
    "task-tracking": {
        fileName: "openclaw-task-tracking.token",
        id: "openclaw-task-tracking",
        scopes: ["agents:write", "tasks:read", "tasks:write"],
    },
} as const;

export type DashboardAutomationProfile = keyof typeof DASHBOARD_AUTOMATION_PROFILES;

export const DASHBOARD_AUTOMATION_PROFILE_NAMES = Object.keys(
    DASHBOARD_AUTOMATION_PROFILES
) as DashboardAutomationProfile[];

export function isDashboardAutomationProfile(
    value: string
): value is DashboardAutomationProfile {
    return DASHBOARD_AUTOMATION_PROFILE_NAMES.includes(
        value as DashboardAutomationProfile
    );
}
