import { RefreshCw } from "lucide-react";

/** Describes loading state props. */
interface LoadingStateProps {
    message?: string;
    size?: "sm" | "md" | "lg" | "fullscreen";
}

const sizeClasses = {
    sm: "h-32",
    md: "h-48",
    lg: "h-64",
    fullscreen: "h-full min-h-0",
};

const iconSizes = {
    sm: "h-4 w-4",
    md: "h-6 w-6",
    lg: "h-8 w-8",
    fullscreen: "h-8 w-8",
};

/** Renders the loading state UI. */
export function LoadingState({ message, size = "md" }: LoadingStateProps) {
    return (
        <div className={`flex ${sizeClasses[size]} items-center justify-center`}>
            <div className="flex flex-col items-center gap-2">
                <RefreshCw
                    className={`${iconSizes[size]} text-primary-400 animate-spin`}
                />
                {message && <p className="text-primary-400 text-sm">{message}</p>}
            </div>
        </div>
    );
}
