import { useNavigate } from "@tanstack/react-router";
import { Activity, LogOut, Menu } from "lucide-react";

import { useHealth } from "../../hooks";
import { useOpenClawSocket } from "../../hooks/useOpenClawSocket";
import { authActions } from "../../stores/authStore";
import { Button } from "../ui/Button";
import { Dropdown } from "../ui/Dropdown";
import { NotificationBell } from "./NotificationBell";

/** Provides props for app header. */
interface AppHeaderProperties {
    title: string;
    isSidebarOpen: boolean;
    sidebarId: string;
    onToggleSidebar: () => void;
}

/**
 * Renders the app header UI.
 * @returns Rendered the app header UI.
 */
export function AppHeader({
    title,
    isSidebarOpen,
    sidebarId,
    onToggleSidebar,
}: AppHeaderProperties) {
    const navigate = useNavigate();
    const { isConnected } = useOpenClawSocket();
    const { data: health, isError: isBackendError } = useHealth();

    const isBackendConnected = !isBackendError && health !== undefined;
    let workerState: "offline" | "ready" | "unknown" = "unknown";
    if (isBackendConnected) {
        workerState = health.checks.worker.ready ? "ready" : "offline";
    }
    const workerStatus = {
        offline: {
            label: "Worker offline",
            symbol: "○",
        },
        ready: {
            label: "Worker online",
            symbol: "●",
        },
        unknown: {
            label: "Worker status unavailable",
            symbol: "?",
        },
    }[workerState];
    const backendCommit = health?.releaseDetails.backendCommit || "unknown";
    const compiledFrontendCommit =
        typeof __APP_COMMIT__ === "string" ? __APP_COMMIT__ : "dev";
    const frontendCommit =
        compiledFrontendCommit === "dev"
            ? health?.releaseDetails.frontendCommit || "dev"
            : compiledFrontendCommit;
    const hasVersionMismatch =
        backendCommit !== "unknown" &&
        frontendCommit !== "unknown" &&
        backendCommit !== frontendCommit;
    const navigationToggleLabel = isSidebarOpen
        ? "Close navigation menu"
        : "Open navigation menu";
    const isOverallHealthy =
        isConnected &&
        isBackendConnected &&
        workerState === "ready" &&
        !hasVersionMismatch;
    const hasSystemError =
        !isConnected || !isBackendConnected || workerState === "offline";
    let systemStatusLabel = "status unavailable";
    let systemStatusClassName =
        "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20";
    if (isOverallHealthy) {
        systemStatusLabel = "all systems online";
        systemStatusClassName =
            "border-green-500/40 bg-green-500/10 text-green-300 hover:bg-green-500/20";
    } else if (hasSystemError) {
        systemStatusLabel = "one or more systems need attention";
        systemStatusClassName =
            "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20";
    } else if (hasVersionMismatch) {
        systemStatusLabel = "version mismatch";
    }

    let workerStatusClassName = "text-primary-400";
    if (workerState === "ready") {
        workerStatusClassName = "text-green-300";
    } else if (workerState === "offline") {
        workerStatusClassName = "text-red-300";
    }

    return (
        <header className="sticky top-0 z-20 border-b border-primary-700 bg-primary-950/95 p-3 backdrop-blur sm:px-6 sm:py-4">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <button
                        type="button"
                        className="rounded-lg p-2 text-primary-300 transition-colors hover:bg-primary-800 hover:text-primary-50 md:hidden"
                        aria-controls={sidebarId}
                        aria-expanded={isSidebarOpen}
                        aria-label={navigationToggleLabel}
                        onClick={onToggleSidebar}
                    >
                        <Menu size={22} />
                    </button>
                    <h1 className="truncate text-xl font-bold text-primary-50 sm:text-2xl">
                        {title}
                    </h1>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                    <Button
                        variant="secondary"
                        size="sm"
                        aria-label="Log out"
                        onClick={() => {
                            void (async () => {
                                await authActions.logout();
                                await navigate({ to: "/login" });
                            })();
                        }}
                    >
                        <LogOut className="size-4" />
                        <span className="hidden sm:inline">Log out</span>
                    </Button>
                    <Dropdown
                        ariaLabel={`System status: ${systemStatusLabel}. Open details`}
                        variant="ghost"
                        triggerClassName={`gap-1 border px-1.5 py-1 ${systemStatusClassName}`}
                        icon={
                            <>
                                <Activity aria-hidden="true" className="size-4" />
                                <span aria-hidden="true">
                                    {isOverallHealthy ? "●" : "○"}
                                </span>
                            </>
                        }
                        content={
                            <div className="w-56 space-y-2 p-2 text-xs">
                                <div className="font-medium text-primary-100">
                                    System status
                                </div>
                                <div className="flex items-center justify-between gap-3 text-primary-300">
                                    <span>WebSocket</span>
                                    <span
                                        className={
                                            isConnected
                                                ? "text-green-300"
                                                : "text-red-300"
                                        }
                                    >
                                        {isConnected ? "online ●" : "Offline ○"}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between gap-3 text-primary-300">
                                    <span>Backend</span>
                                    <span
                                        className={
                                            isBackendConnected
                                                ? "text-green-300"
                                                : "text-red-300"
                                        }
                                    >
                                        {isBackendConnected ? "online ●" : "Offline ○"}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between gap-3 text-primary-300">
                                    <span>Worker</span>
                                    <span className={workerStatusClassName}>
                                        {workerStatus.label.replace(/^Worker /u, "")}{" "}
                                        {workerStatus.symbol}
                                    </span>
                                </div>
                                {hasVersionMismatch ? (
                                    <div className="space-y-1 border-t border-primary-700 pt-2 text-amber-200">
                                        <div className="font-medium">
                                            Version mismatch
                                        </div>
                                        <div className="flex items-center justify-between gap-3">
                                            <span>Frontend</span>
                                            <span className="font-mono">
                                                {frontendCommit}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between gap-3">
                                            <span>Backend</span>
                                            <span className="font-mono">
                                                {backendCommit}
                                            </span>
                                        </div>
                                    </div>
                                ) : undefined}
                            </div>
                        }
                    />
                    <NotificationBell />
                </div>
            </div>
        </header>
    );
}
