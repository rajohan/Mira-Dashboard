import { Input as HeadlessInput } from "@headlessui/react";
import type { InputHTMLAttributes, Ref } from "react";

import { cn } from "../lib/classNames.ts";
import { useFormFieldInvalid } from "./formFieldContext.ts";

export interface InputProps extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "aria-invalid" | "disabled"
> {
    readonly disabled?: boolean;
    readonly invalid?: boolean;
    readonly ref?: Ref<HTMLInputElement>;
}

/**
 * Renders the shared Headless UI-backed Dashboard input.
 * @returns An input with consistent validation and interaction states.
 */
export function Input({ className, disabled, invalid, ref, ...properties }: InputProps) {
    const inheritedInvalid = useFormFieldInvalid();
    const resolvedInvalid = invalid ?? inheritedInvalid;

    return (
        <HeadlessInput
            {...properties}
            className={cn(
                "border-primary-500 bg-primary-950 text-primary-50 w-full max-w-full min-w-0 rounded-lg border px-3 py-2 shadow-sm transition-colors",
                "placeholder:text-primary-400 data-hover:border-accent-400 data-focus:border-accent-400 data-focus:ring-accent-400 data-focus:ring-2 data-focus:outline-none",
                "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500",
                className
            )}
            disabled={disabled}
            invalid={resolvedInvalid}
            ref={ref}
        />
    );
}
