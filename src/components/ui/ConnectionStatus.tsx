import { Wifi, WifiOff } from "lucide-react";

import { cn } from "../../utils/cn";

interface ConnectionStatusProps {
    isConnected: boolean;
    connectedText?: string;
    disconnectedText?: string;
    className?: string;
}

export function ConnectionStatus({
    isConnected,
    connectedText = "Connected",
    disconnectedText = "Disconnected",
    className,
}: ConnectionStatusProps) {
    return (
        <span
            className={cn(
                "flex items-center gap-1 text-sm",
                isConnected ? "text-green-400" : "text-red-400",
                className
            )}
        >
            {isConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
            {isConnected ? connectedText : disconnectedText}
        </span>
    );
}
