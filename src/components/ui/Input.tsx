import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../../utils/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
    ({ className, label, error, ...props }, ref) => {
        return (
            <div className="w-full">
                {label && (
                    <label className="mb-1 block text-sm font-medium text-primary-300">
                        {label}
                    </label>
                )}
                <input
                    ref={ref}
                    className={cn(
                        "w-full rounded-lg border border-primary-600 bg-primary-900 px-3 py-2",
                        "text-primary-50 placeholder-primary-400",
                        "focus:border-transparent focus:outline-none focus:ring-2 focus:ring-accent-500",
                        error && "border-red-500",
                        className
                    )}
                    {...props}
                />
                {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
            </div>
        );
    }
);

Input.displayName = "Input";
