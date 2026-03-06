import { Description, Field, Label, Switch as HeadlessSwitch } from "@headlessui/react";

import { cn } from "../../utils/cn";

interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    description?: string;
    disabled?: boolean;
    className?: string;
}

export function Switch({
    checked,
    onChange,
    label,
    description,
    disabled,
    className,
}: SwitchProps) {
    return (
        <Field
            className={cn("flex items-center justify-between gap-3", className)}
            disabled={disabled}
        >
            {(label || description) && (
                <div className="flex flex-col">
                    {label && (
                        <Label className="text-sm font-medium text-primary-200">
                            {label}
                        </Label>
                    )}
                    {description && (
                        <Description className="text-xs text-primary-400">
                            {description}
                        </Description>
                    )}
                </div>
            )}
            <HeadlessSwitch
                checked={checked}
                onChange={onChange}
                className={cn(
                    "inline-flex h-6 w-11 items-center rounded-full transition focus:outline-none",
                    "data-focus:ring-2 data-focus:ring-accent-500 ring-offset-2 ring-offset-primary-800",
                    checked ? "bg-accent-500" : "bg-primary-600",
                    disabled ? "cursor-not-allowed opacity-50" : ""
                )}
            >
                <span className="sr-only">{label}</span>
                <span
                    className={cn(
                        "size-4 rounded-full bg-white transition",
                        checked ? "translate-x-6" : "translate-x-1"
                    )}
                />
            </HeadlessSwitch>
        </Field>
    );
}
