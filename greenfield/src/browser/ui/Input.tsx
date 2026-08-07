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
                "border-primary-600 bg-primary-950 text-primary-50 w-full rounded-lg border px-3 py-2 shadow-sm",
                "placeholder:text-primary-500 data-hover:border-primary-500 data-focus:border-accent-400 data-focus:ring-accent-400/30 data-focus:ring-2 data-focus:outline-none",
                "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500/25",
                className
            )}
            disabled={disabled}
            invalid={resolvedInvalid}
            ref={ref}
        />
    );
}
