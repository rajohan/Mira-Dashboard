import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../../utils/cn";

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
    label?: string;
    description?: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
    ({ className, label, description, checked, onChange, disabled, ...props }, ref) => {
        return (
            <label
                className={cn(
                    "flex cursor-pointer items-center justify-between",
                    disabled && "cursor-not-allowed opacity-50",
                    className
                )}
            >
                {(label || description) && (
                    <div className="flex flex-col">
                        {label && (
                            <span className="text-sm font-medium text-primary-200">
                                {label}
                            </span>
                        )}
                        {description && (
                            <span className="text-xs text-primary-400">
                                {description}
                            </span>
                        )}
                    </div>
                )}
                <div className="relative">
                    <input
                        ref={ref}
                        type="checkbox"
                        className="peer sr-only"
                        checked={checked}
                        onChange={onChange}
                        disabled={disabled}
                        {...props}
                    />
                    <div
                        className={cn(
                            "h-6 w-11 rounded-full transition-colors",
                            "bg-primary-600 peer-checked:bg-accent-500",
                            "peer-focus:ring-2 peer-focus:ring-accent-500 peer-focus:ring-offset-2 peer-focus:ring-offset-primary-800"
                        )}
                    />
                    <div
                        className={cn(
                            "absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform",
                            "peer-checked:translate-x-5"
                        )}
                    />
                </div>
            </label>
        );
    }
);

Switch.displayName = "Switch";
