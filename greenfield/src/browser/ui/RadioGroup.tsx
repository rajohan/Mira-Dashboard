import {
    Description,
    Field,
    Label,
    Radio,
    RadioGroup as HeadlessRadioGroup,
} from "@headlessui/react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { useFormFieldInvalid } from "./formFieldContext.ts";

export interface RadioGroupOption<TValue extends string> {
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly label: ReactNode;
    readonly value: TValue;
}

interface RadioGroupProps<TValue extends string> {
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly error?: ReactNode;
    readonly invalid?: boolean;
    readonly label: ReactNode;
    readonly name?: string;
    readonly onChange: (value: TValue) => void;
    readonly options: readonly RadioGroupOption<TValue>[];
    readonly orientation?: "horizontal" | "vertical";
    readonly value: TValue;
}

/**
 * Renders one controlled, labelled set of mutually exclusive choices.
 * @returns A responsive Headless UI radio group with shared validation states.
 */
export function RadioGroup<TValue extends string>({
    className,
    description,
    disabled = false,
    error,
    invalid,
    label,
    name,
    onChange,
    options,
    orientation = "vertical",
    value,
}: RadioGroupProps<TValue>) {
    const inheritedInvalid = useFormFieldInvalid();
    const resolvedInvalid = (invalid ?? inheritedInvalid) || error !== undefined;

    return (
        <HeadlessRadioGroup
            aria-invalid={resolvedInvalid || undefined}
            aria-orientation={orientation}
            className={cn("max-w-full min-w-0", className)}
            disabled={disabled}
            name={name}
            onChange={onChange}
            value={value}
        >
            <Label className="text-primary-200 block text-sm font-medium data-disabled:opacity-60">
                {label}
            </Label>
            {description !== undefined && (
                <Description className="text-primary-400 mt-1 text-xs leading-5 data-disabled:opacity-60">
                    {description}
                </Description>
            )}
            <div
                className={cn(
                    "mt-2 max-w-full min-w-0 gap-2",
                    orientation === "horizontal"
                        ? "grid grid-cols-1 sm:grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))]"
                        : "grid grid-cols-1"
                )}
            >
                {options.map((option) => {
                    const optionDisabled = disabled || option.disabled === true;
                    return (
                        <Field
                            className="h-full"
                            disabled={optionDisabled}
                            key={option.value}
                        >
                            <Radio
                                className={cn(
                                    "border-primary-500 bg-primary-950 text-primary-200 group flex size-full max-w-full min-w-0 cursor-pointer items-start gap-3 rounded-lg border p-3 text-left shadow-sm transition-colors",
                                    "not-data-disabled:data-hover:border-accent-400 not-data-disabled:data-hover:bg-primary-900 hover:not-data-disabled:border-accent-400 hover:not-data-disabled:bg-primary-900",
                                    "data-checked:border-accent-400 data-checked:bg-accent-500/15 data-checked:text-primary-50",
                                    "data-focus:ring-accent-400 data-focus:ring-offset-primary-950 data-focus:ring-2 data-focus:ring-offset-2 data-focus:outline-none",
                                    "data-disabled:cursor-not-allowed data-disabled:opacity-55",
                                    resolvedInvalid &&
                                        "border-red-500 ring-1 ring-red-400 data-checked:border-red-400"
                                )}
                                disabled={optionDisabled}
                                value={option.value}
                            >
                                <span
                                    aria-hidden="true"
                                    className="border-primary-500 bg-primary-900 group-data-checked:border-accent-300 group-data-checked:bg-accent-500 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border"
                                >
                                    <span className="invisible size-1.5 rounded-full bg-white group-data-checked:visible" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <Label
                                        as="span"
                                        className="text-primary-100 block cursor-pointer text-sm font-medium wrap-break-word data-disabled:cursor-not-allowed"
                                    >
                                        {option.label}
                                    </Label>
                                    {option.description !== undefined && (
                                        <Description
                                            as="span"
                                            className="text-primary-400 group-data-checked:text-primary-300 mt-0.5 block text-xs leading-5 wrap-break-word data-disabled:opacity-60"
                                        >
                                            {option.description}
                                        </Description>
                                    )}
                                </span>
                            </Radio>
                        </Field>
                    );
                })}
            </div>
            {error !== undefined && (
                <Description className="mt-1.5 text-sm text-red-300">{error}</Description>
            )}
        </HeadlessRadioGroup>
    );
}
