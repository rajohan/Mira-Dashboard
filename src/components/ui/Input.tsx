import { Description, Field, Input as HeadlessInput, Label } from "@headlessui/react";
import type { InputHTMLAttributes } from "react";
import { forwardRef } from "react";

import { cn } from "../../utils/cn";

/** Provides props for input. */
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    description?: string;
    error?: string;
}

/** Renders the input UI. */
export const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className, label, description, error, ...props }, ref) => {
        return (
            <Field>
                {label && (
                    <Label className="text-primary-300 mb-1 block text-sm font-medium">
                        {label}
                    </Label>
                )}
                {description && (
                    <Description className="text-primary-400 mb-1 text-xs">
                        {description}
                    </Description>
                )}
                <HeadlessInput
                    ref={ref}
                    className={cn(
                        "border-primary-600 bg-primary-900 w-full rounded-lg border px-3 py-2",
                        "text-primary-50 placeholder-primary-400",
                        "data-focus:border-accent-500 data-focus:outline-none",
                        "data-hover:border-primary-500",
                        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                        error && "border-red-500",
                        className
                    )}
                    {...props}
                />
                {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
            </Field>
        );
    }
);

Input.displayName = "Input";
