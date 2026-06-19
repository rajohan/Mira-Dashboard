import {
    Checkbox as HeadlessCheckbox,
    Description,
    Field,
    Label,
} from "@headlessui/react";
import { Check } from "lucide-react";

import { cn } from "../../utils/cn";

/** Provides props for checkbox. */
interface CheckboxProperties {
    isChecked: boolean;
    onChange: (isChecked: boolean) => void;
    label?: string;
    description?: string;
    disabled?: boolean;
    className?: string;
}

/** Renders the checkbox UI. */
export function Checkbox({
    isChecked,
    onChange,
    label,
    description,
    disabled,
    className,
}: CheckboxProperties) {
    return (
        <Field className={cn("flex items-center gap-2", className)} disabled={disabled}>
            <HeadlessCheckbox
                checked={isChecked}
                onChange={onChange}
                className={cn(
                    "flex h-5 w-5 items-center justify-center rounded border",
                    "transition-colors",
                    "data-isChecked:border-accent-500 data-isChecked:bg-accent-500",
                    "data-unchecked:border-primary-600 data-unchecked:bg-primary-800",
                    "data-focus:ring-accent-500 data-focus:ring-offset-primary-900 data-focus:ring-2 data-focus:ring-offset-2",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-50"
                )}
            >
                {isChecked && <Check className="h-4 w-4 text-white" strokeWidth={3} />}
            </HeadlessCheckbox>
            {(label || description) && (
                <div className="flex flex-col">
                    {label && <Label className="text-primary-300 text-sm">{label}</Label>}
                    {description && (
                        <Description className="text-primary-400 text-xs">
                            {description}
                        </Description>
                    )}
                </div>
            )}
        </Field>
    );
}
