import { Search, X } from "lucide-react";

import { cn } from "../lib/classNames.ts";
import { Icon } from "./Icon.tsx";
import { IconOnlyButton } from "./IconOnlyButton.tsx";
import { Input } from "./Input.tsx";

interface SearchInputProps {
    readonly className?: string;
    readonly clearLabel?: string;
    readonly disabled?: boolean;
    readonly label: string;
    readonly maxLength?: number;
    readonly onChange: (value: string) => void;
    readonly placeholder?: string;
    readonly value: string;
}

/**
 * Renders a labelled search input with an explicit clear action.
 * @returns The shared compact search control.
 */
export function SearchInput({
    className,
    clearLabel = "Clear search",
    disabled,
    label,
    maxLength,
    onChange,
    placeholder,
    value,
}: SearchInputProps) {
    return (
        <div className={cn("relative min-w-0", className)}>
            <Icon
                className="text-primary-500 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                icon={Search}
                size="sm"
                tone="inherit"
            />
            <Input
                aria-label={label}
                className="pr-10 pl-9"
                disabled={disabled}
                maxLength={maxLength}
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder={placeholder}
                type="search"
                value={value}
            />
            {value.length > 0 && (
                <IconOnlyButton
                    className="absolute top-1/2 right-1.5 -translate-y-1/2"
                    disabled={disabled}
                    icon={X}
                    label={clearLabel}
                    onClick={() => onChange("")}
                    size="sm"
                    variant="ghost"
                />
            )}
        </div>
    );
}
