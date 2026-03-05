import { useOpenClawSocket } from "../../hooks/useOpenClawSocket";
import { ConnectionStatus } from "../ui/ConnectionStatus";
import { NotificationBell } from "./NotificationBell";

interface AppHeaderProps {
    title: string;
}

export function AppHeader({ title }: AppHeaderProps) {
    const { isConnected } = useOpenClawSocket();

    return (
        <header className="sticky top-0 z-20 border-b border-primary-700 bg-primary-950/95 px-6 py-4 backdrop-blur">
            <div className="flex items-center justify-between gap-4">
                <h1 className="text-2xl font-bold text-primary-50">{title}</h1>

                <div className="flex items-center gap-4">
                    <ConnectionStatus isConnected={isConnected} />
                    <NotificationBell isConnected={isConnected} />
                </div>
            </div>
        </header>
    );
}
