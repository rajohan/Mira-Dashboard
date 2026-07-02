import { Description, Field, Label, Switch as HeadlessSwitch } from "@headlessui/react";

import { cn } from "../../utils/cn";

/** Provides props for switch. */
interface SwitchProperties {
    isChecked: boolean;
    onChange: (isChecked: boolean) => void;
    label?: string;
    ariaLabel?: string;
    description?: string;
    disabled?: boolean;
    className?: string;
}

/** Renders the switch UI. */
export function Switch({
    isChecked,
    onChange,
    label,
    ariaLabel,
    description,
    disabled,
    className,
}: SwitchProperties) {
    return (
        <Field
            className={cn("flex items-center justify-between gap-3", className)}
            disabled={disabled}
        >
            {(label || description) && (
                <div className="flex min-w-0 flex-1 flex-col">
                    {label && (
                        <Label className="text-sm font-medium wrap-break-word text-primary-200">
                            {label}
                        </Label>
                    )}
                    {description && (
                        <Description className="text-xs wrap-break-word text-primary-400">
                            {description}
                        </Description>
                    )}
                </div>
            )}
            <HeadlessSwitch
                checked={isChecked}
                onChange={onChange}
                aria-label={label ? undefined : ariaLabel}
                className={cn(
                    "inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:outline-none",
                    "ring-offset-2 ring-offset-primary-800 data-focus:ring-2 data-focus:ring-accent-500",
                    isChecked ? "bg-accent-500" : "bg-primary-600",
                    disabled ? "cursor-not-allowed opacity-50" : ""
                )}
            >
                <span className="sr-only">{label ?? ariaLabel}</span>
                <span
                    className={cn(
                        "size-4 rounded-full bg-white transition",
                        isChecked ? "translate-x-6" : "translate-x-1"
                    )}
                />
            </HeadlessSwitch>
        </Field>
    );
}
