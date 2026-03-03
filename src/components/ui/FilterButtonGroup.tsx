import { Button } from "./Button";

interface FilterOption<T extends string> {
    value: T;
    label: string;
}

interface FilterButtonGroupProps<T extends string> {
    options: readonly FilterOption<T>[];
    value: T;
    onChange: (value: T) => void;
    className?: string;
}

export function FilterButtonGroup<T extends string>({
    options,
    value,
    onChange,
    className,
}: FilterButtonGroupProps<T>) {
    return (
        <div className={className}>
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
