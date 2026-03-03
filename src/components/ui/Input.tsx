import { Description, Field, Input as HeadlessInput, Label } from "@headlessui/react";
import type { InputHTMLAttributes } from "react";
import { forwardRef } from "react";

import { cn } from "../../utils/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    description?: string;
    error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className, label, description, error, ...props }, ref) => {
        return (
            <Field>
                {label && (
                    <Label className="mb-1 block text-sm font-medium text-primary-300">
                        {label}
                    </Label>
                )}
                {description && (
                    <Description className="mb-1 text-xs text-primary-400">
                        {description}
                    </Description>
                )}
                <HeadlessInput
                    ref={ref}
                    className={cn(
                        "w-full rounded-lg border border-primary-600 bg-primary-900 px-3 py-2",
                        "text-primary-50 placeholder-primary-400",
                        "data-focus:border-transparent data-focus:outline-none data-focus:ring-2 data-focus:ring-accent-500",
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
