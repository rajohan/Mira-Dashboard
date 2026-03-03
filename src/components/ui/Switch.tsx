import { Switch as HeadlessSwitch } from "@headlessui/react";
import { cn } from "../../utils/cn";

interface SwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    description?: string;
    disabled?: boolean;
    className?: string;
}

export function Switch({
    checked,
    onChange,
    label,
    description,
    disabled,
    className,
}: SwitchProps) {
    return (
        <HeadlessSwitch.Group>
            <div className={cn("flex items-center justify-between", className)}>
                {(label || description) && (
                    <div className="flex flex-col">
                        {label && (
                            <HeadlessSwitch.Label className="text-sm font-medium text-primary-200">
                                {label}
                            </HeadlessSwitch.Label>
                        )}
                        {description && (
                            <span className="text-xs text-primary-400">
                                {description}
                            </span>
                        )}
                    </div>
                )}
                <HeadlessSwitch
                    checked={checked}
                    onChange={onChange}
                    disabled={disabled}
                    className={cn(
                        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                        "focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-primary-800",
                        disabled && "cursor-not-allowed opacity-50",
                        checked ? "bg-accent-500" : "bg-primary-600"
                    )}
                >
                    <span className="sr-only">{label}</span>
                    <span
                        className={cn(
                            "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                            checked ? "translate-x-5" : "translate-x-1"
                        )}
                    />
                </HeadlessSwitch>
            </div>
        </HeadlessSwitch.Group>
    );
}