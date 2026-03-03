import { Description, Field, Label } from "@headlessui/react";
import { forwardRef } from "react";
import type { TextareaHTMLAttributes } from "react";

import { cn } from "../../utils/cn";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
    label?: string;
    description?: string;
    error?: string;
    variant?: "default" | "code";
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
    ({ className, label, description, error, variant = "default", ...props }, ref) => {
        return (
            <Field className={cn(variant === "code" && "h-full")}>
                {label && (
                    <Label className="mb-1.5 block text-sm font-medium text-slate-300">
                        {label}
                    </Label>
                )}
                {description && (
                    <Description className="mb-1 text-xs text-slate-400">
                        {description}
                    </Description>
                )}
                <textarea
                    ref={ref}
                    className={cn(
                        variant === "default" && [
                            "w-full rounded-lg border border-slate-600 bg-slate-700 px-3 py-2",
                            "text-slate-100 placeholder-slate-500",
                            "focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500",
                            "hover:border-slate-500",
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