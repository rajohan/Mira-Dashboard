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
            className={cn("flex items-center justify-between", className)}
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
                    "group inline-flex h-6 w-11 items-center rounded-full transition",
                    "data-focus:ring-2 data-focus:ring-accent-500 data-focus:ring-offset-2 data-focus:ring-offset-primary-800 focus:outline-none",
                    "data-checked:bg-accent-500 data-unchecked:bg-primary-600",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50"
                )}
            >
                <span className="sr-only">{label}</span>
                <span className="group-data-checked:tranprimary-x-6 size-4 tranprimary-x-1 rounded-full bg-white transition" />
            </HeadlessSwitch>
        </Field>
    );
}
