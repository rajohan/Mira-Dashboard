import {
    Checkbox as HeadlessCheckbox,
    Description,
    Field,
    Label,
} from "@headlessui/react";
import { Check } from "lucide-react";

import { cn } from "../../utils/cn";

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    description?: string;
    disabled?: boolean;
    className?: string;
}

export function Checkbox({
    checked,
    onChange,
    label,
    description,
    disabled,
    className,
}: CheckboxProps) {
    return (
        <Field className={cn("flex items-center gap-2", className)} disabled={disabled}>
            <HeadlessCheckbox
                checked={checked}
                onChange={onChange}
                className={cn(
                    "flex h-5 w-5 items-center justify-center rounded border",
                    "transition-colors",
                    "data-checked:border-accent-500 data-checked:bg-accent-500",
                    "data-unchecked:border-slate-600 data-unchecked:bg-slate-800",
                    "data-focus:ring-2 data-focus:ring-accent-500 data-focus:ring-offset-2 data-focus:ring-offset-slate-900",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50"
                )}
            >
                {checked && <Check className="h-4 w-4 text-white" strokeWidth={3} />}
            </HeadlessCheckbox>
            {(label || description) && (
                <div className="flex flex-col">
                    {label && <Label className="text-sm text-slate-300">{label}</Label>}
                    {description && (
                        <Description className="text-xs text-slate-400">
                            {description}
                        </Description>
                    )}
                </div>
            )}
        </Field>
    );
}
