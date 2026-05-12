import { useNavigate } from "@tanstack/react-router";
import { Menu } from "lucide-react";

import { useHealth } from "../../hooks";
import { useOpenClawSocket } from "../../hooks/useOpenClawSocket";
import { authActions } from "../../stores/authStore";
import { Button } from "../ui/Button";
import { NotificationBell } from "./NotificationBell";

interface AppHeaderProps {
    title: string;
    isSidebarOpen: boolean;
    sidebarId: string;
    onOpenSidebar: () => void;
}

export function AppHeader({
    title,
    isSidebarOpen,
    sidebarId,
    onOpenSidebar,
}: AppHeaderProps) {
    const navigate = useNavigate();
    const { isConnected } = useOpenClawSocket();
    const { data: health, isError: isBackendError } = useHealth();

    const isBackendConnected = !isBackendError && health?.status === "ok";
    const backendCommit = health?.backendCommit || "unknown";
    const frontendCommit = __APP_COMMIT__;
    const hasVersionMismatch =
        backendCommit !== "unknown" &&
        frontendCommit !== "unknown" &&
        backendCommit !== frontendCommit;

    return (
        <header className="border-primary-700 bg-primary-950/95 sticky top-0 z-20 border-b px-3 py-3 backdrop-blur sm:px-6 sm:py-4">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <button
                        type="button"
                        className="text-primary-300 hover:bg-primary-800 hover:text-primary-50 rounded-lg p-2 transition-colors md:hidden"
                        aria-controls={sidebarId}
                        aria-expanded={isSidebarOpen}
                        aria-label="Open navigation menu"
                        onClick={onOpenSidebar}
                    >
                        <Menu size={22} />
                    </button>
                    <h1 className="text-primary-50 truncate text-xl font-bold sm:text-2xl">
                        {title}
                    </h1>
                </div>

                <div className="flex shrink-0 items-center gap-2 sm:gap-4">
                    {hasVersionMismatch && (
                        <span className="hidden rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200 sm:inline-flex">
                            Version mismatch (FE {frontendCommit} / BE {backendCommit})
                        </span>
                    )}
                    <div className="hidden items-center gap-2 text-xs sm:flex">
                        <span
                            className={[
                                "inline-flex items-center gap-1 rounded-md border px-2 py-1",
                                isConnected
                                    ? "border-green-500/40 bg-green-500/10 text-green-300"
                                    : "border-red-500/40 bg-red-500/10 text-red-300",
                            ].join(" ")}
                            title={
                                isConnected
                                    ? "WebSocket connected"
                                    : "WebSocket disconnected"
                            }
                        >
                            <span className="font-medium">WS</span>
                            <span>{isConnected ? "●" : "○"}</span>
                        </span>
                        <span
                            className={[
                                "inline-flex items-center gap-1 rounded-md border px-2 py-1",
                                isBackendConnected
                                    ? "border-green-500/40 bg-green-500/10 text-green-300"
                                    : "border-red-500/40 bg-red-500/10 text-red-300",
                            ].join(" ")}
                            title={
                                isBackendConnected
                                    ? "Backend connected"
                                    : "Backend disconnected"
                            }
                        >
                            <span className="font-medium">BE</span>
                            <span>{isBackendConnected ? "●" : "○"}</span>
                        </span>
                    </div>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            void authActions
                                .logout()
                                .then(() => navigate({ to: "/login" }));
                        }}
                    >
                        Log out
                    </Button>
                    <NotificationBell />
                </div>
            </div>
        </header>
    );
}
