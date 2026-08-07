import {
    Checkbox as HeadlessCheckbox,
    Description,
    Field,
    Label,
} from "@headlessui/react";
import { Check } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { Icon } from "./Icon.tsx";

interface CheckboxProps {
    readonly checked: boolean;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly label: ReactNode;
    readonly onChange: (checked: boolean) => void;
}

/**
 * Renders one labelled Headless UI checkbox.
 * @returns An accessible controlled checkbox with shared interaction states.
 */
export function Checkbox({
    checked,
    className,
    description,
    disabled,
    label,
    onChange,
}: CheckboxProps) {
    return (
        <Field className={cn("flex items-start gap-2.5", className)} disabled={disabled}>
            <HeadlessCheckbox
                checked={checked}
                className={cn(
                    "group mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                    "data-checked:border-accent-500 data-checked:bg-accent-500 data-unchecked:border-primary-600 data-unchecked:bg-primary-900",
                    "data-focus:ring-accent-400 data-focus:ring-offset-primary-900 data-focus:ring-2 data-focus:ring-offset-2 data-focus:outline-none",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-55"
                )}
                onChange={onChange}
            >
                <Icon
                    className="invisible text-white group-data-checked:visible"
                    icon={Check}
                    size="sm"
                    strokeWidth={3}
                    tone="inherit"
                />
            </HeadlessCheckbox>
            <div className="min-w-0">
                <Label className="text-primary-200 block text-sm font-medium data-disabled:opacity-55">
                    {label}
                </Label>
                {description !== undefined && (
                    <Description className="text-primary-400 mt-0.5 text-xs leading-5 data-disabled:opacity-55">
                        {description}
                    </Description>
                )}
            </div>
        </Field>
    );
}
