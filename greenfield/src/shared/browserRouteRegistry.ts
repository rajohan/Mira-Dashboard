/** Source-backed metadata for one browser route owned by the greenfield Dashboard. */
export interface DashboardRouteDocumentation {
    readonly access: "public" | "session";
    readonly featureOwner: string;
    readonly navigationLabel: string | null;
    readonly path: string;
    readonly summary: string;
}

/** Browser route and feature metadata consumed by routing types and generated documentation. */
export const dashboardRouteDocumentation = Object.freeze([
    {
        access: "session",
        featureOwner: "overview",
        navigationLabel: "Dashboard",
        path: "/",
        summary: "Shows bounded operational summaries for implemented Dashboard domains.",
    },
    {
        access: "session",
        featureOwner: "security",
        navigationLabel: null,
        path: "/account-security",
        summary: "Manages password, MFA factors, recovery codes, and browser sessions.",
    },
    {
        access: "session",
        featureOwner: "settings",
        navigationLabel: "Settings",
        path: "/settings",
        summary:
            "Combines Dashboard account security with bounded secret-free OpenClaw settings.",
    },
    {
        access: "session",
        featureOwner: "agents",
        navigationLabel: "Agents",
        path: "/agents",
        summary: "Shows the reviewed agent directory, task state, and durable history.",
    },
    {
        access: "session",
        featureOwner: "chat",
        navigationLabel: "Chat",
        path: "/chat",
        summary: "Runs the bounded persistent Gateway chat and attachment workflow.",
    },
    {
        access: "session",
        featureOwner: "files",
        navigationLabel: "Files",
        path: "/files",
        summary:
            "Browses, previews, downloads, uploads, and CAS-replaces workspace files.",
    },
    {
        access: "session",
        featureOwner: "monitoring",
        navigationLabel: null,
        path: "/incidents",
        summary: "Lists and inspects persisted monitoring incident generations.",
    },
    {
        access: "session",
        featureOwner: "jobs",
        navigationLabel: "Jobs",
        path: "/jobs",
        summary: "Shows Dashboard jobs, schedules, worker state, and OpenClaw cron.",
    },
    {
        access: "public",
        featureOwner: "security",
        navigationLabel: null,
        path: "/login",
        summary: "Authenticates a browser session and completes pending MFA login.",
    },
    {
        access: "session",
        featureOwner: "logs",
        navigationLabel: "Logs",
        path: "/logs",
        summary:
            "Reads redacted named log sources and queues fixed maintenance policies.",
    },
    {
        access: "session",
        featureOwner: "moltbook",
        navigationLabel: "Moltbook",
        path: "/moltbook",
        summary:
            "Reads the bounded worker-owned Moltbook profile, feeds, posts, and comments snapshot.",
    },
    {
        access: "session",
        featureOwner: "monitoring",
        navigationLabel: "Reports",
        path: "/reports",
        summary: "Lists and renders durable bounded monitoring reports.",
    },
    {
        access: "session",
        featureOwner: "gateway-sessions",
        navigationLabel: "Sessions",
        path: "/sessions",
        summary: "Shows and controls the bounded current Gateway session projection.",
    },
    {
        access: "session",
        featureOwner: "tasks",
        navigationLabel: "Tasks",
        path: "/tasks",
        summary: "Manages the durable task board, updates, labels, and assignments.",
    },
    {
        access: "session",
        featureOwner: "terminal",
        navigationLabel: "Terminal",
        path: "/terminal",
        summary:
            "Runs a recent-MFA-gated interactive PTY without persisting its contents.",
    },
] as const satisfies readonly DashboardRouteDocumentation[]);
