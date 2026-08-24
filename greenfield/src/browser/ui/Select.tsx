import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from "@headlessui/react";
import { Check, ChevronsUpDown } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { useFormFieldInvalid } from "./formFieldContext.ts";
import { Icon } from "./Icon.tsx";

export interface SelectOption<TValue extends string> {
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly label: ReactNode;
    readonly value: TValue;
}

interface SelectProps<TValue extends string> {
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly disabled?: boolean;
    readonly invalid?: boolean;
    readonly name?: string;
    readonly onChange: (value: TValue) => void;
    readonly options: readonly SelectOption<TValue>[];
    readonly value: TValue;
}

/**
 * Renders one controlled Headless UI listbox with shared Dashboard styling.
 * @returns An accessible select-like control and anchored option panel.
 */
export function Select<TValue extends string>({
    ariaLabel,
    className,
    disabled = false,
    invalid,
    name,
    onChange,
    options,
    value,
}: SelectProps<TValue>) {
    const inheritedInvalid = useFormFieldInvalid();
    const selected = options.find((option) => option.value === value);

    return (
        <Listbox
            disabled={disabled}
            invalid={invalid ?? inheritedInvalid}
            name={name}
            onChange={onChange}
            value={value}
        >
            <ListboxButton
                aria-label={ariaLabel}
                className={cn(
                    "border-primary-600 bg-primary-950 text-primary-50 relative flex min-h-10 w-full items-center rounded-lg border py-2 pr-9 pl-3 text-left shadow-sm",
                    "data-hover:border-primary-500 data-focus:border-accent-400 data-focus:ring-accent-400/30 data-focus:ring-2 data-focus:outline-none",
                    "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500/25",
                    className
                )}
            >
                <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
                <Icon
                    className="text-primary-400 pointer-events-none absolute right-3"
                    icon={ChevronsUpDown}
                    size="sm"
                    tone="inherit"
                />
            </ListboxButton>
            <ListboxOptions
                anchor="bottom start"
                className={cn(
                    "border-primary-600 bg-primary-900 z-60 mt-1 max-h-64 w-(--button-width) overflow-auto rounded-lg border p-1 shadow-xl shadow-black/35",
                    "transition duration-100 focus:outline-none data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none"
                )}
                transition
            >
                {options.map((option) => (
                    <ListboxOption
                        className={cn(
                            "group text-primary-200 relative flex cursor-pointer items-start gap-2 rounded-md py-2 pr-3 pl-9 text-sm select-none",
                            "data-focus:bg-primary-700 data-focus:text-primary-50 data-disabled:cursor-not-allowed data-disabled:opacity-50"
                        )}
                        disabled={option.disabled}
                        key={option.value}
                        value={option.value}
                    >
                        <Icon
                            className="text-accent-300 invisible absolute top-2.5 left-3 group-data-selected:visible"
                            icon={Check}
                            size="sm"
                            tone="inherit"
                        />
                        <span className="min-w-0">
                            <span className="block truncate font-medium">
                                {option.label}
                            </span>
                            {option.description !== undefined && (
                                <span className="text-primary-400 group-data-focus:text-primary-300 mt-0.5 block text-xs leading-5">
                                    {option.description}
                                </span>
                            )}
                        </span>
                    </ListboxOption>
                ))}
            </ListboxOptions>
        </Listbox>
    );
}
