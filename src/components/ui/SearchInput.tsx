import { Search, X } from "lucide-react";

/** Provides props for search input. */
interface SearchInputProperties {
    value: string;
    onChange: (value: string) => void;
    label?: string;
    placeholder?: string;
    clearLabel?: string;
}

/** Renders the search input UI. */
export function SearchInput({
    value,
    onChange,
    label,
    placeholder = "Search...",
    clearLabel,
}: SearchInputProperties) {
    const normalizedLabel = label?.trim() || undefined;
    const normalizedPlaceholder = placeholder.trim() || undefined;
    const accessibleLabel = normalizedLabel ?? normalizedPlaceholder ?? "Search";

    return (
        <div className="relative max-w-md flex-1">
            <Search
                aria-hidden="true"
                className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-primary-400"
            />
            <input
                type="text"
                aria-label={accessibleLabel}
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="w-full rounded-lg border border-primary-600 bg-primary-700 px-10 py-2 text-sm text-primary-100 focus:border-accent-500 focus:outline-none"
            />
            {value ? (
                <button
                    type="button"
                    aria-label={clearLabel ?? `Clear ${accessibleLabel.toLowerCase()}`}
                    onClick={() => onChange("")}
                    className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-primary-400 hover:text-primary-100 focus:ring-2 focus:ring-accent-400 focus:outline-none"
                >
                    <X aria-hidden="true" className="size-4" />
                </button>
            ) : undefined}
        </div>
    );
}
