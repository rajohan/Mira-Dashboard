import { DatePicker } from "./DatePicker.tsx";
import { Fieldset } from "./Fieldset.tsx";
import { TimePicker } from "./TimePicker.tsx";

export interface DateTimePickerValue {
    readonly date: Date;
    readonly time: string;
}

interface DateTimePickerProps {
    readonly disabled?: boolean;
    readonly error?: string;
    readonly label: string;
    readonly minimumDate?: Date;
    readonly onChange: (value: DateTimePickerValue) => void;
    readonly value: DateTimePickerValue;
}

/** @returns The shared date and 24-hour time pickers composed as one fieldset. */
export function DateTimePicker({
    disabled = false,
    error,
    label,
    minimumDate,
    onChange,
    value,
}: DateTimePickerProps) {
    return (
        <Fieldset disabled={disabled} error={error} legend={label}>
            {({ describedBy, invalid }) => (
                <div className="mt-2 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.75fr)]">
                    <DatePicker
                        ariaDescribedBy={describedBy}
                        ariaLabel={`${label} date`}
                        disabled={disabled}
                        invalid={invalid}
                        label="Date (DD.MM.YYYY)"
                        minimumDate={minimumDate}
                        onChange={(date) => onChange({ ...value, date })}
                        value={value.date}
                    />
                    <TimePicker
                        ariaDescribedBy={describedBy}
                        disabled={disabled}
                        invalid={invalid}
                        label="Time (24-hour)"
                        onChange={(time) => onChange({ ...value, time })}
                        value={value.time}
                    />
                </div>
            )}
        </Fieldset>
    );
}
