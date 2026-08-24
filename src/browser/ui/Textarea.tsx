import { Textarea as HeadlessTextarea } from "@headlessui/react";
import type { Ref, TextareaHTMLAttributes } from "react";

import { cn } from "../lib/classNames.ts";
import { useFormFieldInvalid } from "./formFieldContext.ts";

export interface TextareaProps extends Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "aria-invalid" | "disabled"
> {
    readonly disabled?: boolean;
    readonly invalid?: boolean;
    readonly ref?: Ref<HTMLTextAreaElement>;
}

/**
 * Renders the shared Headless UI-backed multiline input.
 * @returns A textarea with consistent validation and interaction states.
 */
export function Textarea({
    className,
    disabled,
    invalid,
    ref,
    ...properties
}: TextareaProps) {
    const inheritedInvalid = useFormFieldInvalid();
    return (
        <HeadlessTextarea
            {...properties}
            className={cn(
                "border-primary-500 bg-primary-950 text-primary-50 min-h-28 w-full max-w-full min-w-0 resize-y rounded-lg border px-3 py-2 shadow-sm transition-colors",
                "placeholder:text-primary-400 data-hover:border-accent-400 data-focus:border-accent-400 data-focus:ring-accent-400 data-focus:ring-2 data-focus:outline-none",
                "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500",
                className
            )}
            disabled={disabled}
            invalid={invalid ?? inheritedInvalid}
            ref={ref}
        />
    );
}
