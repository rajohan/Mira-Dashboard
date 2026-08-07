import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, MonitorX, RefreshCw, ShieldX, Trash2 } from "lucide-react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { resetAuthenticatedBrowserCache } from "../auth/authQueries.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import {
    browserSessionsQueryOptions,
    refreshSecurityQueries,
} from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

const anonymousAuthStatus: AuthStatus = Object.freeze({ state: "anonymous" });

/**
 * Renders current and historical browser-session controls.
 * @returns The browser-session management section.
 */
export function SessionManagementSection() {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const sessions = useQuery(browserSessionsQueryOptions(client));

    async function leaveAuthenticatedBrowser(operation: () => Promise<unknown>) {
        const result = await action.run(operation);
        if (result.status !== "success") return;
        resetAuthenticatedBrowserCache(queryClient, anonymousAuthStatus);
        await navigate({ replace: true, to: "/login" });
        resetAuthenticatedBrowserCache(queryClient, anonymousAuthStatus);
    }

    async function revokeSession(sessionId: string) {
        const result = await action.run(() =>
            client.mutation("auth.revokeSession", { sessionId })
        );
        if (result.status === "success") await refreshSecurityQueries(queryClient);
    }

    async function revokeOtherSessions() {
        const result = await action.run(() =>
            client.mutation("auth.revokeOtherSessions", {})
        );
        if (result.status === "success") await refreshSecurityQueries(queryClient);
    }

    return (
        <SecuritySection
            description="Review browser sessions, revoke individual devices, or end every session."
            id="session-management-heading"
            title="Browser sessions"
        >
            <Alert className="mb-4" message={action.error} />
            {sessions.isPending && (
                <LoadingState label="Loading browser sessions…" size="sm" />
            )}
            {sessions.isError && (
                <div>
                    <Alert message={dashboardBrowserFailureMessage(sessions.error)} />
                    <Button
                        className="mt-3"
                        onClick={() => void sessions.refetch()}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Try again
                    </Button>
                </div>
            )}
            {sessions.isSuccess && sessions.data.sessions.length === 0 && (
                <EmptyState
                    description="No active browser session records are available."
                    icon={MonitorX}
                    title="No browser sessions"
                />
            )}
            {sessions.isSuccess && (
                <ul className="space-y-3">
                    {sessions.data.sessions.map((session) => (
                        <li
                            className="border-primary-700 rounded-lg border p-3 text-sm"
                            key={session.id}
                        >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <p className="text-primary-100 font-medium">
                                        {session.isCurrent
                                            ? "Current browser"
                                            : "Browser session"}
                                        {session.isCurrent && (
                                            <Badge className="ml-2" variant="success">
                                                Current
                                            </Badge>
                                        )}
                                    </p>
                                    <p className="text-primary-400 mt-1">
                                        {session.authMethod} · last active{" "}
                                        {formatDashboardDateTime(session.lastSeenAtMs)}
                                    </p>
                                    {session.userAgent !== undefined && (
                                        <p className="text-primary-500 mt-1 break-all">
                                            {session.userAgent}
                                        </p>
                                    )}
                                </div>
                                {!session.isCurrent && (
                                    <Button
                                        busy={action.busy}
                                        busyLabel="Revoking…"
                                        onClick={() => void revokeSession(session.id)}
                                        size="sm"
                                        variant="danger"
                                    >
                                        <Icon icon={Trash2} size="sm" tone="inherit" />
                                        Revoke
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <div className="border-primary-700 mt-5 flex flex-wrap gap-3 border-t pt-5">
                <Button
                    busy={action.busy}
                    busyLabel="Revoking…"
                    onClick={() => void revokeOtherSessions()}
                    variant="secondary"
                >
                    <Icon icon={MonitorX} size="sm" tone="inherit" />
                    Revoke other sessions
                </Button>
                <Button
                    busy={action.busy}
                    busyLabel="Revoking…"
                    onClick={() =>
                        void leaveAuthenticatedBrowser(() =>
                            client.mutation("auth.revokeAllSessions", {})
                        )
                    }
                    variant="danger"
                >
                    <Icon icon={ShieldX} size="sm" tone="inherit" />
                    Revoke every session
                </Button>
                <Button
                    busy={action.busy}
                    busyLabel="Signing out…"
                    onClick={() =>
                        void leaveAuthenticatedBrowser(() =>
                            client.mutation("auth.logout", {})
                        )
                    }
                    variant="secondary"
                >
                    <Icon icon={LogOut} size="sm" tone="inherit" />
                    Sign out this browser
                </Button>
            </div>
        </SecuritySection>
    );
}
