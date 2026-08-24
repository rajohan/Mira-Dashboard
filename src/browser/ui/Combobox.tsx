import {
    Combobox as HeadlessCombobox,
    ComboboxButton,
    ComboboxInput,
    ComboboxOption as HeadlessComboboxOption,
    ComboboxOptions,
} from "@headlessui/react";
import { Check, ChevronsUpDown } from "lucide-react";
import { useState, type FocusEventHandler } from "react";

import { cn } from "../lib/classNames.ts";
import { useFormFieldInvalid } from "./formFieldContext.ts";
import { Icon } from "./Icon.tsx";
import { interactiveTapClassName } from "./interactionStyles.ts";

export interface ComboboxOption<TValue extends string> {
    readonly description?: string;
    readonly disabled?: boolean;
    readonly keywords?: readonly string[];
    readonly label: string;
    readonly value: TValue;
}

interface ComboboxProps<TValue extends string> {
    readonly ariaLabel: string;
    readonly className?: string;
    readonly disabled?: boolean;
    readonly invalid?: boolean;
    readonly name?: string;
    readonly onBlur?: FocusEventHandler<HTMLInputElement>;
    readonly onChange: (value: TValue) => void;
    readonly options: readonly ComboboxOption<TValue>[];
    readonly placeholder?: string;
    readonly value: TValue;
}

const emptyOption = Symbol("empty combobox option");
const virtualizationThreshold = 50;

function normalizedSearchText(value: string): string {
    return value.trim().toLocaleLowerCase("en-US");
}

function optionMatchesQuery<TValue extends string>(
    option: ComboboxOption<TValue>,
    query: string
): boolean {
    const terms = normalizedSearchText(query).split(/\s+/u).filter(Boolean);
    if (terms.length === 0) return true;
    const searchable = normalizedSearchText(
        [
            option.label,
            option.value,
            option.description ?? "",
            ...(option.keywords ?? []),
        ].join(" ")
    );
    return terms.every((term) => searchable.includes(term));
}

/**
 * Renders one searchable, strictly option-backed Headless UI combobox.
 * @returns A text control and anchored option panel that virtualizes large sets.
 */
export function Combobox<TValue extends string>({
    ariaLabel,
    className,
    disabled,
    invalid,
    name,
    onBlur,
    onChange,
    options,
    placeholder = "Search…",
    value,
}: ComboboxProps<TValue>) {
    const inheritedInvalid = useFormFieldInvalid();
    const resolvedInvalid = invalid ?? inheritedInvalid;
    const [query, setQuery] = useState("");
    const optionsByValue = new Map(
        options.map((option) => [option.value, option] as const)
    );
    if (!optionsByValue.has(value)) {
        throw new RangeError("Combobox value must match one option");
    }
    const filteredValues = options
        .filter((option) => optionMatchesQuery(option, query))
        .map((option) => option.value);
    const virtualOptions: (TValue | typeof emptyOption)[] =
        filteredValues.length === 0 ? [emptyOption] : filteredValues;
    const virtualized =
        options.length >= virtualizationThreshold &&
        options.every((option) => option.description === undefined);

    function renderOption(optionValue: TValue | typeof emptyOption, key?: string) {
        if (optionValue === emptyOption) {
            return (
                <HeadlessComboboxOption
                    className="text-primary-400 h-10 px-3 py-2 text-sm"
                    disabled
                    key={key}
                    value={emptyOption}
                >
                    No matching options
                </HeadlessComboboxOption>
            );
        }

        const definition = optionsByValue.get(optionValue);
        if (definition === undefined) {
            throw new RangeError("Combobox option is not registered");
        }
        return (
            <HeadlessComboboxOption
                className={cn(
                    "group text-primary-200 relative flex w-full max-w-full cursor-pointer items-start gap-2 rounded-md py-2 pr-3 pl-9 text-sm select-none",
                    "data-selected:bg-accent-500/15 data-selected:text-primary-50 data-focus:bg-primary-700 data-focus:text-primary-50 data-disabled:cursor-not-allowed data-disabled:opacity-50",
                    definition.description === undefined && "h-10"
                )}
                disabled={definition.disabled}
                key={key}
                value={optionValue}
            >
                <Icon
                    className="text-accent-300 invisible absolute top-2.5 left-3 group-data-selected:visible"
                    icon={Check}
                    size="sm"
                    tone="inherit"
                />
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{definition.label}</span>
                    {definition.description !== undefined && (
                        <span className="text-primary-400 group-data-focus:text-primary-300 mt-0.5 block text-xs leading-5">
                            {definition.description}
                        </span>
                    )}
                </span>
            </HeadlessComboboxOption>
        );
    }

    const renderedStaticOptions =
        filteredValues.length === 0
            ? renderOption(emptyOption, "empty")
            : filteredValues.map((optionValue) => renderOption(optionValue, optionValue));

    return (
        <HeadlessCombobox<TValue | typeof emptyOption>
            disabled={disabled}
            invalid={resolvedInvalid}
            name={name}
            onChange={(nextValue) => {
                if (nextValue !== null && nextValue !== emptyOption) onChange(nextValue);
            }}
            onClose={() => setQuery("")}
            value={value}
            virtual={
                virtualized
                    ? {
                          disabled: (optionValue) =>
                              optionValue === emptyOption ||
                              optionsByValue.get(optionValue)?.disabled === true,
                          options: virtualOptions,
                      }
                    : undefined
            }
        >
            <div className={cn("relative max-w-full min-w-0", className)}>
                <ComboboxInput<TValue | typeof emptyOption>
                    aria-label={ariaLabel}
                    autoComplete="off"
                    className={cn(
                        "border-primary-500 bg-primary-950 text-primary-50 w-full max-w-full min-w-0 rounded-lg border py-2 pr-10 pl-3 shadow-sm transition-colors",
                        "placeholder:text-primary-400 data-hover:border-accent-400 data-focus:border-accent-400 data-focus:ring-accent-400 data-focus:ring-2 data-focus:outline-none",
                        "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500"
                    )}
                    displayValue={(optionValue) =>
                        optionValue === emptyOption
                            ? ""
                            : (optionsByValue.get(optionValue)?.label ?? optionValue)
                    }
                    onBlur={onBlur}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={placeholder}
                />
                <ComboboxButton
                    aria-label={`Open ${ariaLabel}`}
                    className={cn(
                        interactiveTapClassName,
                        "text-primary-400 data-hover:bg-primary-800 data-hover:text-primary-50 data-active:bg-primary-700 absolute inset-y-px right-px flex w-9 items-center justify-center rounded-r-lg transition-colors outline-none data-disabled:cursor-not-allowed data-disabled:opacity-60"
                    )}
                >
                    <Icon icon={ChevronsUpDown} size="sm" tone="inherit" />
                </ComboboxButton>
            </div>
            <ComboboxOptions
                anchor={{ gap: 4, padding: 8, to: "bottom start" }}
                className={cn(
                    "border-primary-600 bg-primary-900 z-60 max-h-64 w-(--input-width) max-w-[calc(100vw-1rem)] overflow-auto rounded-lg border p-1 shadow-xl shadow-black/35",
                    "transition duration-100 outline-none data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none",
                    virtualized && "h-64"
                )}
                modal={false}
                transition
            >
                {virtualized
                    ? ({ option }) => renderOption(option as TValue | typeof emptyOption)
                    : renderedStaticOptions}
            </ComboboxOptions>
        </HeadlessCombobox>
    );
}
