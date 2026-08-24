import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut, MonitorX, RefreshCw, ShieldX, Trash2 } from "lucide-react";
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
    | Readonly<{ kind: "revoke-all" }>
    | Readonly<{ kind: "revoke-others" }>
    | Readonly<{ kind: "revoke-session"; sessionId: string }>;

function sessionConfirmationCopy(confirmation: SessionConfirmation) {
    switch (confirmation.kind) {
        case "revoke-session": {
            return {
                confirmLabel: "Sign out browser",
                description: "This browser will be signed out and must sign in again.",
                title: "Sign out this browser?",
            };
        }
        case "revoke-others": {
            return {
                confirmLabel: "Sign out other browsers",
                description:
                    "Every browser except this one will be signed out and must sign in again.",
                title: "Sign out every other browser?",
            };
        }
        case "revoke-all": {
            return {
                confirmLabel: "Sign out every browser",
                description:
                    "Every browser, including this one, will be signed out immediately.",
                title: "Sign out every browser?",
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
            }
        } finally {
            setConfirmation(undefined);
        }
    }

    const confirmationCopy =
        confirmation === undefined ? undefined : sessionConfirmationCopy(confirmation);

    return (
        <SecuritySection
            description="See where you are signed in and sign out one browser or all of them."
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
                    description="There are no signed-in browsers to show."
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
                                        aria-label={`Sign out browser ${session.userAgent ?? "unnamed browser"}`}
                                        busy={action.busy}
                                        busyLabel="Signing out…"
                                        onClick={() =>
                                            setConfirmation({
                                                kind: "revoke-session",
                                                sessionId: session.id,
                                            })
                                        }
                                        size="sm"
                                        variant="danger"
                                    >
                                        <Icon icon={Trash2} size="sm" tone="inherit" />
                                        Sign out
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
                    busyLabel="Signing out…"
                    onClick={() => setConfirmation({ kind: "revoke-others" })}
                    variant="secondary"
                >
                    <Icon icon={MonitorX} size="sm" tone="inherit" />
                    Sign out other browsers
                </Button>
                <Button
                    busy={action.busy}
                    busyLabel="Signing out…"
                    onClick={() => setConfirmation({ kind: "revoke-all" })}
                    variant="danger"
                >
                    <Icon icon={ShieldX} size="sm" tone="inherit" />
                    Sign out every browser
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
