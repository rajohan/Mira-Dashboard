import { Fieldset } from "./Fieldset.tsx";
import { Select, type SelectOption } from "./Select.tsx";

const hourOptions = Object.freeze(
    Array.from({ length: 24 }, (_value, hour) => {
        const value = hour.toString().padStart(2, "0");
        return { label: value, value };
    })
) satisfies readonly SelectOption<string>[];

const minuteOptions = Object.freeze(
    Array.from({ length: 60 }, (_value, minute) => {
        const value = minute.toString().padStart(2, "0");
        return { label: value, value };
    })
) satisfies readonly SelectOption<string>[];

const timeValuePattern = /^(?<hour>[01]\d|2[0-3]):(?<minute>[0-5]\d)$/u;

export interface TimePickerProps {
    readonly ariaDescribedBy?: string;
    readonly className?: string;
    readonly description?: string;
    readonly disabled?: boolean;
    readonly error?: string;
    readonly invalid?: boolean;
    readonly label: string;
    readonly onChange: (value: string) => void;
    readonly value: string;
}

/** @returns An explicit, locale-independent 24-hour hour-and-minute picker. */
export function TimePicker({
    ariaDescribedBy,
    className,
    description,
    disabled = false,
    error,
    invalid = error !== undefined,
    label,
    onChange,
    value,
}: TimePickerProps) {
    const match = timeValuePattern.exec(value);
    const hour = match?.groups?.hour ?? "00";
    const minute = match?.groups?.minute ?? "00";

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
            <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <Select
                    ariaLabel={`${label}, hour`}
                    disabled={disabled}
                    invalid={invalid}
                    onChange={(nextHour) => onChange(`${nextHour}:${minute}`)}
                    options={hourOptions}
                    value={hour}
                />
                <span aria-hidden="true" className="text-primary-300 font-semibold">
                    :
                </span>
                <Select
                    ariaLabel={`${label}, minute`}
                    disabled={disabled}
                    invalid={invalid}
                    onChange={(nextMinute) => onChange(`${hour}:${nextMinute}`)}
                    options={minuteOptions}
                    value={minute}
                />
            </div>
        </Fieldset>
    );
}
