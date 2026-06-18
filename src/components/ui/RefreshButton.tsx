import { RefreshCw } from "lucide-react";

import { Button } from "./Button";

/** Provides props for refresh button. */
interface RefreshButtonProperties {
    onClick: () => void;
    isLoading?: boolean;
    disabled?: boolean;
    label?: string;
    size?: "sm" | "md";
    variant?: "primary" | "secondary" | "ghost" | "danger";
}

/** Renders the refresh button UI. */
export function RefreshButton({
    onClick,
    isLoading = false,
    disabled = false,
    label = "Refresh",
    size = "sm",
    variant = "secondary",
}: RefreshButtonProperties) {
    return (
        <Button
            variant={variant}
            size={size}
            onClick={onClick}
            aria-label={label || "Refresh"}
            disabled={disabled || isLoading}
        >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            {label ? <span>{label}</span> : undefined}
        </Button>
    );
}
