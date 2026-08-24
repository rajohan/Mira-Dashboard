import { Description, Field, Label, Switch as HeadlessSwitch } from "@headlessui/react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { useFormFieldInvalid } from "./formFieldContext.ts";

interface SwitchProps {
    readonly checked: boolean;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly error?: ReactNode;
    readonly form?: string;
    readonly invalid?: boolean;
    readonly label: ReactNode;
    readonly name?: string;
    readonly onChange: (checked: boolean) => void;
    readonly value?: string;
}

/**
 * Renders one controlled boolean setting with its operator-facing context.
 * @returns A labelled Headless UI switch with shared interaction and validation states.
 */
export function Switch({
    checked,
    className,
    description,
    disabled = false,
    error,
    form,
    invalid,
    label,
    name,
    onChange,
    value,
}: SwitchProps) {
    const inheritedInvalid = useFormFieldInvalid();
    const resolvedInvalid = (invalid ?? inheritedInvalid) || error !== undefined;

    return (
        <Field
            className={cn(
                "flex max-w-full min-w-0 items-start justify-between gap-3",
                className
            )}
            disabled={disabled}
        >
            <div className="min-w-0 flex-1">
                <Label className="text-primary-200 block cursor-pointer text-sm font-medium wrap-break-word data-disabled:cursor-not-allowed data-disabled:opacity-60">
                    {label}
                </Label>
                {description !== undefined && (
                    <Description className="text-primary-400 mt-0.5 text-xs leading-5 wrap-break-word data-disabled:opacity-60">
                        {description}
                    </Description>
                )}
                {error !== undefined && (
                    <Description className="mt-1 text-sm text-red-300">
                        {error}
                    </Description>
                )}
            </div>
            <HeadlessSwitch
                aria-invalid={resolvedInvalid || undefined}
                checked={checked}
                className={cn(
                    "border-primary-500 bg-primary-700 group relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border shadow-sm transition-colors",
                    "not-data-disabled:data-hover:border-primary-300 not-data-disabled:data-hover:bg-primary-600 hover:not-data-disabled:border-primary-300 hover:not-data-disabled:bg-primary-600",
                    "data-checked:border-accent-300 data-checked:bg-accent-500",
                    "not-data-disabled:data-checked:data-hover:border-accent-100 not-data-disabled:data-checked:data-hover:bg-accent-400 hover:not-data-disabled:data-checked:border-accent-100 hover:not-data-disabled:data-checked:bg-accent-400",
                    "data-focus:ring-accent-300 data-focus:ring-offset-primary-950 data-focus:ring-2 data-focus:ring-offset-2 data-focus:outline-none",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-55",
                    resolvedInvalid && "border-red-500 ring-1 ring-red-400"
                )}
                disabled={disabled}
                form={form}
                name={name}
                onChange={onChange}
                value={value}
            >
                <span
                    aria-hidden="true"
                    className="size-4 translate-x-1 rounded-full bg-white shadow transition-transform group-data-checked:translate-x-6 motion-reduce:transition-none"
                />
            </HeadlessSwitch>
        </Field>
    );
}
