import { RefreshCw } from "lucide-react";

interface LoadingStateProps {
    message?: string;
    size?: "sm" | "md" | "lg" | "fullscreen";
}

const sizeClasses = {
    sm: "h-32",
    md: "h-48",
    lg: "h-64",
    fullscreen: "h-[calc(100vh-4rem)]",
};

const iconSizes = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
    fullscreen: "h-8 w-8",
};

export function LoadingState({ message, size = "md" }: LoadingStateProps) {
    return (
        <div className={`flex ${sizeClasses[size]} items-center justify-center`}>
            <div className="flex flex-col items-center gap-2">
                <RefreshCw className={`${iconSizes[size]} animate-spin text-primary-400`} />
                {message && <p className="text-sm text-primary-400">{message}</p>}
            </div>
        </div>
    );
}
