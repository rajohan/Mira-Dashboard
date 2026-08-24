import "@daypicker/react/style.css";
import {
    DayFlag,
    DayPicker,
    getDefaultClassNames,
    SelectionState,
    UI,
} from "@daypicker/react";
import { nb } from "@daypicker/react/locale";
import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { CalendarDays, ChevronDown } from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../lib/classNames.ts";
import { Fieldset } from "./Fieldset.tsx";
import { Icon } from "./Icon.tsx";

export interface DatePickerProps {
    readonly ariaDescribedBy?: string;
    readonly ariaLabel?: string;
    readonly className?: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly error?: string;
    readonly invalid?: boolean;
    readonly label: string;
    readonly minimumDate?: Date;
    readonly onChange: (value: Date) => void;
    readonly value: Date;
}

const defaultClassNames = getDefaultClassNames();
const calendarClassNames = {
    [DayFlag.disabled]: cn(defaultClassNames[DayFlag.disabled], "text-primary-600"),
    [DayFlag.outside]: cn(defaultClassNames[DayFlag.outside], "text-primary-400"),
    [DayFlag.today]: cn(defaultClassNames[DayFlag.today], "text-accent-300"),
    [SelectionState.selected]: cn(
        defaultClassNames[SelectionState.selected],
        "text-accent-100"
    ),
    [UI.CaptionLabel]: cn(
        defaultClassNames[UI.CaptionLabel],
        "text-primary-100 text-base"
    ),
    [UI.DayButton]: cn(
        defaultClassNames[UI.DayButton],
        "hover:enabled:bg-primary-700! focus-visible:ring-accent-400 transition-colors focus-visible:ring-2 focus-visible:outline-none"
    ),
    [UI.NextMonthButton]: cn(
        defaultClassNames[UI.NextMonthButton],
        "text-primary-300 hover:bg-primary-700! hover:text-primary-50! focus-visible:ring-accent-400 rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
    ),
    [UI.PreviousMonthButton]: cn(
        defaultClassNames[UI.PreviousMonthButton],
        "text-primary-300 hover:bg-primary-700! hover:text-primary-50! focus-visible:ring-accent-400 rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
    ),
    [UI.Weekday]: cn(defaultClassNames[UI.Weekday], "text-primary-300"),
};
const calendarStyle = {
    "--rdp-accent-background-color": "#22366e",
    "--rdp-accent-color": "#8eaeff",
    "--rdp-day-height": "2.5rem",
    "--rdp-day-width": "min(2.5rem, calc((100vw - 4rem) / 7))",
    "--rdp-day_button-height": "2.375rem",
    "--rdp-day_button-width": "calc(var(--rdp-day-width) - 0.125rem)",
    "--rdp-selected-border": "2px solid #8eaeff",
    "--rdp-today-color": "#8eaeff",
} as CSSProperties;

function dateAtLocalNoon(date: Date): Date {
    const localNoon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
    return Number.isNaN(localNoon.getTime()) ? new Date(date) : localNoon;
}

function formattedPickerDate(date: Date): string {
    return [
        date.getDate().toString().padStart(2, "0"),
        (date.getMonth() + 1).toString().padStart(2, "0"),
        date.getFullYear().toString(),
    ].join(".");
}

/** @returns A reusable localized calendar picker for one browser-local date. */
export function DatePicker({
    ariaDescribedBy,
    ariaLabel,
    className,
    description,
    disabled = false,
    error,
    invalid = error !== undefined,
    label,
    minimumDate,
    onChange,
    value,
}: DatePickerProps) {
    const formattedDate = formattedPickerDate(value);

    return (
        <Fieldset
            ariaDescribedBy={ariaDescribedBy}
            className={className}
            description={description}
            disabled={disabled}
            error={error}
            invalid={invalid}
            legend={label}
        >
            {({ describedBy, invalid: resolvedInvalid }) => (
                <Popover className="mt-2 min-w-0">
                    {({ close }) => (
                        <>
                            <PopoverButton
                                aria-describedby={describedBy}
                                aria-invalid={resolvedInvalid ? true : undefined}
                                aria-label={`Choose ${ariaLabel ?? label}, selected ${formattedDate}`}
                                className={cn(
                                    "border-primary-500 bg-primary-950 text-primary-50 flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-left shadow-sm transition-colors",
                                    "data-hover:border-accent-400 data-focus:border-accent-400 data-focus:ring-accent-400 data-focus:ring-2 data-focus:outline-none",
                                    "data-disabled:cursor-not-allowed data-disabled:opacity-60 data-invalid:border-red-500 data-invalid:ring-red-500"
                                )}
                                data-invalid={resolvedInvalid ? "" : undefined}
                                disabled={disabled}
                            >
                                <Icon
                                    className="text-primary-400"
                                    icon={CalendarDays}
                                    size="sm"
                                    tone="inherit"
                                />
                                <span className="min-w-0 flex-1 truncate">
                                    {formattedDate}
                                </span>
                                <Icon
                                    className="text-primary-400"
                                    icon={ChevronDown}
                                    size="sm"
                                    tone="inherit"
                                />
                            </PopoverButton>
                            <PopoverPanel
                                anchor={{ gap: 8, padding: 8, to: "bottom start" }}
                                className="border-primary-600 bg-primary-900 text-primary-100 z-70 max-w-[calc(100vw-1rem)] rounded-lg border p-2 text-sm shadow-xl shadow-black/40 outline-none"
                            >
                                <DayPicker
                                    classNames={calendarClassNames}
                                    disabled={
                                        minimumDate === undefined
                                            ? undefined
                                            : { before: minimumDate }
                                    }
                                    locale={nb}
                                    mode="single"
                                    navLayout="around"
                                    onSelect={(date) => {
                                        onChange(dateAtLocalNoon(date));
                                        close();
                                    }}
                                    required
                                    selected={dateAtLocalNoon(value)}
                                    showOutsideDays
                                    style={calendarStyle}
                                />
                            </PopoverPanel>
                        </>
                    )}
                </Popover>
            )}
        </Fieldset>
    );
}
