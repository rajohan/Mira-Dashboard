import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Activity, LogOut } from "lucide-react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { authStatusQueryKey, publishAuthenticationStatus } from "../auth/authQueries.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { cn } from "../lib/classNames.ts";
import { AuthenticatedNotificationCenter } from "../notifications/AuthenticatedNotificationCenter.tsx";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/Popover.tsx";
import { Text } from "../ui/Text.tsx";
import {
    dashboardHealthDiagnosticsQueryOptions,
    dashboardHealthSnapshotIsStale,
    projectDashboardSystemStatus,
    type DashboardSystemComponentState,
} from "./dashboardSystemStatus.ts";

const anonymousAuthStatus: AuthStatus = Object.freeze({ state: "anonymous" });

const componentLabels: Readonly<Record<DashboardSystemComponentState, string>> =
    Object.freeze({
        offline: "Needs attention",
        online: "Online",
        stale: "Stale",
        unavailable: "Checking",
    });
const overallLabels: Readonly<Record<DashboardSystemComponentState, string>> =
    Object.freeze({
        offline: "one or more systems need attention",
        online: "all systems online",
        stale: "last known status is stale",
        unavailable: "status unavailable",
    });

function statusClassName(state: DashboardSystemComponentState): string {
    switch (state) {
        case "online": {
            return "border-green-500/40 bg-green-500/10 text-green-300 data-hover:bg-green-500/20 data-hover:text-green-300 hover:bg-green-500/20 hover:text-green-300";
        }
        case "offline": {
            return "border-red-500/40 bg-red-500/10 text-red-300 data-hover:bg-red-500/20 data-hover:text-red-300 hover:bg-red-500/20 hover:text-red-300";
        }
        case "stale": {
            return "border-amber-500/40 bg-amber-500/10 text-amber-200 data-hover:bg-amber-500/20 data-hover:text-amber-200 hover:bg-amber-500/20 hover:text-amber-200";
        }
        case "unavailable": {
            return "border-amber-500/40 bg-amber-500/10 text-amber-200 data-hover:bg-amber-500/20 data-hover:text-amber-200 hover:bg-amber-500/20 hover:text-amber-200";
        }
    }
}

interface StatusRowProps {
    readonly label: string;
    readonly state: DashboardSystemComponentState;
}

function StatusRow({ label, state }: StatusRowProps) {
    return (
        <div className="flex items-center justify-between gap-4">
            <Text size="sm" tone="muted">
                {label}
            </Text>
            <Text
                as="span"
                className={cn(
                    "font-medium",
                    state === "online" && "text-green-300",
                    state === "offline" && "text-red-300",
                    state === "stale" && "text-amber-200",
                    state === "unavailable" && "text-amber-200"
                )}
                size="sm"
                tone="inherit"
            >
                {componentLabels[state]} {state === "online" ? "●" : "○"}
            </Text>
        </div>
    );
}

/** @returns Global status and session controls after authentication is confirmed. */
export function DashboardHeaderControls() {
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    if (authentication?.state !== "authenticated") return null;
    return <AuthenticatedDashboardHeaderControls />;
}

/** @returns Queries and controls that must never mount before authentication. */
function AuthenticatedDashboardHeaderControls() {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const health = useQuery(dashboardHealthDiagnosticsQueryOptions(client));
    const status = projectDashboardSystemStatus(
        health.data,
        dashboardHealthSnapshotIsStale({
            fetchStatus: health.fetchStatus,
            hasData: health.data !== undefined,
            isError: health.isError,
            isStale: health.isStale,
        })
    );
    const overallLabel = overallLabels[status.overall];

    async function logout(): Promise<void> {
        const result = await action.run(() => client.mutation("auth.logout", {}));
        if (result.status !== "success") return;
        await publishAuthenticationStatus(queryClient, anonymousAuthStatus);
        await navigate({ replace: true, to: "/login" });
    }

    return (
        <div className="flex min-w-0 items-center gap-2">
            {action.error !== undefined && (
                <Text
                    className="sr-only sm:not-sr-only sm:max-w-56"
                    role="alert"
                    tone="danger"
                >
                    {action.error}
                </Text>
            )}
            <Button
                aria-label="Log out"
                busy={action.busy}
                busyLabel="Logging out…"
                onClick={() => void logout()}
                size="sm"
                variant="secondary"
            >
                <Icon icon={LogOut} size="sm" tone="inherit" />
                <span className="hidden sm:inline">Log out</span>
            </Button>
            <Popover>
                <PopoverTrigger
                    aria-label={`System status: ${overallLabel}. Open details`}
                    className={cn("gap-1 border px-2", statusClassName(status.overall))}
                    size="sm"
                    title={`System status: ${overallLabel}`}
                    variant="ghost"
                >
                    <Icon icon={Activity} size="sm" tone="inherit" />
                    <span aria-hidden="true">
                        {status.overall === "online" ? "●" : "○"}
                    </span>
                </PopoverTrigger>
                <PopoverContent className="w-64 space-y-3">
                    <Heading level={2} size="subsection">
                        System status
                    </Heading>
                    <StatusRow label="Dashboard backend" state={status.backend} />
                    <StatusRow label="Dashboard worker" state={status.worker} />
                    <StatusRow label="OpenClaw Gateway" state={status.gateway} />
                </PopoverContent>
            </Popover>
            <AuthenticatedNotificationCenter />
        </div>
    );
}
