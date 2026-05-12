import { Button } from "./Button";

/** Describes filter option. */
interface FilterOption<T extends string> {
    value: T;
    label: string;
}

/** Describes filter button group props. */
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
        <div className={"flex flex-wrap gap-2 " + (className || "")}>
            {options.map((option) => (
                <Button
                    key={option.value}
                    variant={value === option.value ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </Button>
            ))}
        </div>
    );
}
