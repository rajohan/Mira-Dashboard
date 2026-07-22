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
import { type CSSProperties, useId } from "react";

import { cn } from "../../utils/cn";
import { APP_TIME_ZONE, appTimeZoneParts } from "../../utils/date";
import { appDateTimeToTimestamp } from "../../utils/format";
import { Select } from "./Select";

export interface DateTimePickerValue {
    day: number;
    hour: string;
    minute: string;
    month: number;
    year: number;
}

interface DateTimePickerProperties {
    error?: string;
    label: string;
    onChange: (value: DateTimePickerValue) => void;
    value: DateTimePickerValue;
}

const hourOptions = Array.from({ length: 24 }, (_value, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
});
const minuteOptions = Array.from({ length: 60 }, (_value, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
});
const defaultClassNames = getDefaultClassNames();
const calendarClassNames = {
    [DayFlag.disabled]: cn(defaultClassNames[DayFlag.disabled], "text-primary-600"),
    [DayFlag.outside]: cn(defaultClassNames[DayFlag.outside], "text-primary-500"),
    [DayFlag.today]: cn(defaultClassNames[DayFlag.today], "text-accent-300"),
    [SelectionState.selected]: cn(
        defaultClassNames[SelectionState.selected],
        "text-accent-100"
    ),
    [UI.CaptionLabel]: cn(
        defaultClassNames[UI.CaptionLabel],
        "text-base text-primary-100"
    ),
    [UI.DayButton]: cn(
        defaultClassNames[UI.DayButton],
        "transition-colors focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none enabled:hover:bg-primary-700!"
    ),
    [UI.NextMonthButton]: cn(
        defaultClassNames[UI.NextMonthButton],
        "rounded-md text-primary-300 transition-colors hover:bg-primary-700! hover:text-primary-50! focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none"
    ),
    [UI.PreviousMonthButton]: cn(
        defaultClassNames[UI.PreviousMonthButton],
        "rounded-md text-primary-300 transition-colors hover:bg-primary-700! hover:text-primary-50! focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:outline-none"
    ),
    [UI.Weekday]: cn(defaultClassNames[UI.Weekday], "text-primary-400"),
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

function formatPickerDate(value: DateTimePickerValue): string {
    return `${String(value.day).padStart(2, "0")}/${String(value.month).padStart(2, "0")}/${value.year}`;
}

function selectedCalendarDate(value: DateTimePickerValue): Date | undefined {
    const timestamp = appDateTimeToTimestamp(value.year, value.month, value.day, 12, 0);
    return timestamp === undefined ? undefined : new Date(timestamp);
}

/** Renders a localized calendar with an explicit 24-hour time selector. */
export function DateTimePicker({
    error,
    label,
    onChange,
    value,
}: DateTimePickerProperties) {
    const id = useId();
    const labelId = `${id}-label`;
    const errorId = `${id}-error`;
    const selectedDate = selectedCalendarDate(value);
    const formattedDate = formatPickerDate(value);

    return (
        <div
            role="group"
            aria-labelledby={labelId}
            aria-describedby={error ? errorId : undefined}
            className="min-w-0"
        >
            <div id={labelId} className="mb-1 text-sm font-medium text-primary-300">
                {label}
            </div>
            <div
                data-testid="date-time-picker-fields"
                className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.75fr)]"
            >
                <div className="min-w-0">
                    <div className="mb-1 text-sm font-medium text-primary-300">
                        Date (DD/MM/YYYY)
                    </div>
                    <Popover className="min-w-0">
                        {({ close }) => (
                            <>
                                <PopoverButton
                                    aria-label={`Choose ${label} date, selected ${formattedDate}`}
                                    aria-invalid={Boolean(error)}
                                    className="flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-primary-600 bg-primary-900 px-3 text-left text-primary-50 outline-none hover:border-primary-500 data-focus:border-accent-500"
                                >
                                    <CalendarDays className="size-4 shrink-0 text-primary-400" />
                                    <span className="min-w-0 flex-1 truncate">
                                        {formattedDate}
                                    </span>
                                    <ChevronDown className="size-4 shrink-0 text-primary-400" />
                                </PopoverButton>
                                <PopoverPanel
                                    anchor={{ to: "bottom start", gap: 8 }}
                                    className="z-70 max-w-[calc(100vw-2rem)] rounded-lg border border-primary-600 bg-primary-800 p-2 text-sm text-primary-100 shadow-xl outline-none"
                                >
                                    <div data-testid="date-picker-calendar">
                                        <DayPicker
                                            required
                                            mode="single"
                                            locale={nb}
                                            navLayout="around"
                                            selected={selectedDate}
                                            showOutsideDays
                                            timeZone={APP_TIME_ZONE}
                                            classNames={calendarClassNames}
                                            style={calendarStyle}
                                            onSelect={(date) => {
                                                const parts = appTimeZoneParts(date);
                                                onChange({
                                                    ...value,
                                                    day: parts.day,
                                                    month: parts.month,
                                                    year: parts.year,
                                                });
                                                close();
                                            }}
                                        />
                                    </div>
                                </PopoverPanel>
                            </>
                        )}
                    </Popover>
                </div>
                <div className="min-w-0">
                    <div className="mb-1 text-sm font-medium text-primary-300">
                        Time (24-hour)
                    </div>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                        <Select
                            ariaLabel={`${label} hour`}
                            value={value.hour}
                            options={hourOptions}
                            onChange={(hour) => onChange({ ...value, hour })}
                            width="w-full"
                            menuWidth="w-24"
                        />
                        <span className="text-sm text-primary-400">:</span>
                        <Select
                            ariaLabel={`${label} minute`}
                            value={value.minute}
                            options={minuteOptions}
                            onChange={(minute) => onChange({ ...value, minute })}
                            width="w-full"
                            menuWidth="w-24"
                        />
                    </div>
                </div>
            </div>
            {error ? (
                <p id={errorId} className="mt-1 text-sm text-red-400">
                    {error}
                </p>
            ) : undefined}
        </div>
    );
}
