import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Laptop, LogOut, MonitorX, RefreshCw } from "lucide-react";
import { useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { publishAuthenticationStatus } from "../auth/authQueries.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import {
    browserSessionsQueryOptions,
    refreshSecurityQueries,
} from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

const anonymousAuthStatus: AuthStatus = Object.freeze({ state: "anonymous" });

type SessionConfirmation =
    | Readonly<{ kind: "logout-current" }>
    | Readonly<{ kind: "revoke-all" }>
    | Readonly<{ kind: "revoke-others" }>
    | Readonly<{ kind: "revoke-session"; sessionId: string }>;

function sessionConfirmationCopy(confirmation: SessionConfirmation) {
    switch (confirmation.kind) {
        case "logout-current": {
            return {
                confirmLabel: "Log out",
                description: "This browser will be signed out immediately.",
                title: "Log out this browser?",
            };
        }
        case "revoke-session": {
            return {
                confirmLabel: "Revoke",
                description: "This browser session will be revoked immediately.",
                title: "Revoke this session?",
            };
        }
        case "revoke-others": {
            return {
                confirmLabel: "Log out others",
                description:
                    "Every browser except this one will be signed out and must sign in again.",
                title: "Log out every other browser?",
            };
        }
        case "revoke-all": {
            return {
                confirmLabel: "Log out all",
                description:
                    "Every browser, including this one, will be signed out immediately.",
                title: "Log out every browser?",
            };
        }
    }
}

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
    const [confirmation, setConfirmation] = useState<SessionConfirmation>();

    async function leaveAuthenticatedBrowser(operation: () => Promise<unknown>) {
        const result = await action.run(operation);
        if (result.status !== "success") return;
        await publishAuthenticationStatus(queryClient, anonymousAuthStatus);
        await navigate({ replace: true, to: "/login" });
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

    async function confirmSessionAction() {
        const pendingConfirmation = confirmation;
        if (pendingConfirmation === undefined) return;
        try {
            switch (pendingConfirmation.kind) {
                case "revoke-session": {
                    await revokeSession(pendingConfirmation.sessionId);
                    break;
                }
                case "revoke-others": {
                    await revokeOtherSessions();
                    break;
                }
                case "revoke-all": {
                    await leaveAuthenticatedBrowser(() =>
                        client.mutation("auth.revokeAllSessions", {})
                    );
                    break;
                }
                case "logout-current": {
                    await leaveAuthenticatedBrowser(() =>
                        client.mutation("auth.logout", {})
                    );
                    break;
                }
            }
        } finally {
            setConfirmation(undefined);
        }
    }

    const confirmationCopy =
        confirmation === undefined ? undefined : sessionConfirmationCopy(confirmation);

    return (
        <SecuritySection
            actions={
                <div className="flex flex-wrap gap-2">
                    <Button
                        busy={action.busy}
                        busyLabel="Logging out…"
                        disabled={
                            !sessions.isSuccess || sessions.data.sessions.length <= 1
                        }
                        onClick={() => setConfirmation({ kind: "revoke-others" })}
                        size="sm"
                        variant="secondary"
                    >
                        Log out others
                    </Button>
                    <Button
                        busy={action.busy}
                        busyLabel="Logging out…"
                        disabled={!sessions.isSuccess}
                        onClick={() => setConfirmation({ kind: "revoke-all" })}
                        size="sm"
                        variant="danger"
                    >
                        <Icon icon={LogOut} size="sm" tone="inherit" />
                        Log out all
                    </Button>
                </div>
            }
            description="Sessions expire after inactivity and can be revoked independently."
            id="session-management-heading"
            icon={Laptop}
            title="Active sessions"
        >
            <Alert className="mb-4" message={action.error} />
            {sessions.isPending && (
                <LoadingState label="Loading browser sessions…" size="sm" />
            )}
            {sessions.isError && (
                <Alert
                    action={
                        <Button
                            onClick={() => void sessions.refetch()}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Try again
                        </Button>
                    }
                    message={dashboardBrowserFailureMessage(sessions.error)}
                />
            )}
            {sessions.isSuccess && sessions.data.sessions.length === 0 && (
                <EmptyState
                    description="There are no signed-in browsers to show."
                    icon={MonitorX}
                    title="No active sessions"
                />
            )}
            {sessions.isSuccess && (
                <ul className="space-y-2">
                    {sessions.data.sessions.map((session) => (
                        <li
                            className="border-primary-700 bg-primary-900/40 flex flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                            key={session.id}
                        >
                            <div className="min-w-0">
                                <div className="text-primary-100 flex min-w-0 items-center gap-2 font-medium">
                                    <span className="truncate">
                                        {session.userAgent ?? "Unknown browser"}
                                    </span>
                                    {session.isCurrent && (
                                        <Badge className="shrink-0" variant="success">
                                            Current
                                        </Badge>
                                    )}
                                </div>
                                <p className="text-primary-400 mt-1 text-xs">
                                    Last active{" "}
                                    {formatDashboardDateTime(session.lastSeenAtMs)} ·{" "}
                                    {session.authMethod}
                                </p>
                            </div>
                            <Button
                                aria-label={`${session.isCurrent ? "Log out" : "Revoke"} ${session.userAgent ?? "unknown browser"}`}
                                busy={action.busy}
                                busyLabel={
                                    session.isCurrent ? "Logging out…" : "Revoking…"
                                }
                                className="shrink-0"
                                onClick={() =>
                                    setConfirmation(
                                        session.isCurrent
                                            ? { kind: "logout-current" }
                                            : {
                                                  kind: "revoke-session",
                                                  sessionId: session.id,
                                              }
                                    )
                                }
                                size="sm"
                                variant={session.isCurrent ? "danger" : "secondary"}
                            >
                                {session.isCurrent ? "Log out" : "Revoke"}
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            <ConfirmModal
                busy={action.busy}
                confirmLabel={confirmationCopy?.confirmLabel}
                danger
                description={confirmationCopy?.description ?? ""}
                onCancel={() => setConfirmation(undefined)}
                onConfirm={() => void confirmSessionAction()}
                open={confirmation !== undefined}
                title={confirmationCopy?.title ?? "Confirm session action"}
            />
        </SecuritySection>
    );
}
