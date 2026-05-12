import { Description, Field, Label } from "@headlessui/react";
import type { TextareaHTMLAttributes } from "react";
import { forwardRef } from "react";

import { cn } from "../../utils/cn";

/** Provides props for textarea. */
interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    label?: string;
    description?: string;
    error?: string;
    variant?: "default" | "code";
}

/** Renders the textarea UI. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, label, description, error, variant = "default", ...props }, ref) => {
        return (
            <Field className={cn(variant === "code" && "h-full")}>
                {label && (
                    <Label className="text-primary-300 mb-1.5 block text-sm font-medium">
                        {label}
                    </Label>
                )}
                {description && (
                    <Description className="text-primary-400 mb-1 text-xs">
                        {description}
                    </Description>
                )}
                <textarea
                    ref={ref}
                    className={cn(
                        variant === "default" && [
                            "border-primary-600 bg-primary-700 w-full rounded-lg border px-3 py-2",
                            "text-primary-100 placeholder-primary-500",
                            "focus:border-accent-500 focus:outline-none",
                            "hover:border-primary-500",
                        ],
                        variant === "code" && [
                            "h-full w-full resize-none bg-transparent p-4 font-mono text-sm",
                            "focus:outline-none",
                        ],
                        "disabled:cursor-not-allowed disabled:opacity-50",
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

Textarea.displayName = "Textarea";
