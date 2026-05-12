import { RefreshCw } from "lucide-react";

import { Button } from "./Button";

interface RefreshButtonProps {
    onClick: () => void;
    isLoading?: boolean;
    disabled?: boolean;
    label?: string;
    size?: "sm" | "md";
    variant?: "primary" | "secondary" | "ghost" | "danger";
}

export function RefreshButton({
    onClick,
    isLoading = false,
    disabled = false,
    label = "Refresh",
    size = "sm",
    variant = "secondary",
}: RefreshButtonProps) {
    return (
        <Button
            variant={variant}
            size={size}
            onClick={onClick}
            disabled={disabled || isLoading}
            className="gap-2"
        >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            {label ? <span>{label}</span> : null}
        </Button>
    );
}
