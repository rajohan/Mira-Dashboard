import type { ReactNode } from "react";

import { Button } from "./Button";

/** Represents filter option. */
interface FilterOption<T extends string> {
    value: T;
    label: string;
    icon?: ReactNode;
}

/** Provides props for filter button group. */
interface FilterButtonGroupProperties<T extends string> {
    ariaLabel: string;
    options: readonly FilterOption<T>[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}

/** Renders the filter button group UI. */
export function FilterButtonGroup<T extends string>({
    ariaLabel,
    options,
    value,
    onChange,
    className,
}: FilterButtonGroupProperties<T>) {
    return (
        <div
            role="group"
            aria-label={ariaLabel}
            className={"flex flex-wrap gap-1.5 " + (className || "")}
        >
            {options.map((option) => (
                <Button
                    key={option.value}
                    variant={value === option.value ? "primary" : "secondary"}
                    size="sm"
                    aria-pressed={value === option.value}
                    onClick={() => onChange(option.value)}
                >
                    {option.icon}
                    {option.label}
                </Button>
            ))}
        </div>
    );
}
