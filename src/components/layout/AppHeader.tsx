import { useHealth } from "../../hooks";
import { useOpenClawSocket } from "../../hooks/useOpenClawSocket";
import { NotificationBell } from "./NotificationBell";

interface AppHeaderProps {
    title: string;
}

export function AppHeader({ title }: AppHeaderProps) {
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
        <header className="sticky top-0 z-20 border-b border-primary-700 bg-primary-950/95 px-6 py-4 backdrop-blur">
            <div className="flex items-center justify-between gap-4">
                <h1 className="text-2xl font-bold text-primary-50">{title}</h1>

                <div className="flex items-center gap-4">
                    {hasVersionMismatch && (
                        <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
                            Version mismatch (FE {frontendCommit} / BE {backendCommit})
                        </span>
                    )}
                    <div className="flex items-center gap-2 text-xs">
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
                    <NotificationBell />
                </div>
            </div>
        </header>
    );
}
