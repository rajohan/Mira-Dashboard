import { Button } from "./Button";

/** Represents filter option. */
interface FilterOption<T extends string> {
    value: T;
    label: string;
}

/** Provides props for filter button group. */
interface FilterButtonGroupProps<T extends string> {
    options: readonly FilterOption<T>[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}

/** Renders the filter button group UI. */
export function FilterButtonGroup<T extends string>({
    options,
    value,
    onChange,
    className,
}: FilterButtonGroupProps<T>) {
    return (
        <div className={"flex flex-wrap gap-1.5 " + (className || "")}>
            {options.map((option) => (
                <Button
                    key={option.value}
                    variant={value === option.value ? "primary" : "secondary"}
                    size="sm"
                    aria-pressed={value === option.value}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </Button>
            ))}
        </div>
    );
}
