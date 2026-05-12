import { Search } from "lucide-react";

/** Describes search input props. */
interface SearchInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

/** Renders the search input UI. */
export function SearchInput({
    value,
    onChange,
    placeholder = "Search...",
}: SearchInputProps) {
    return (
        <div className="relative max-w-md flex-1">
            <Search className="text-primary-400 absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <input
                type="text"
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="border-primary-600 bg-primary-700 text-primary-100 focus:border-accent-500 w-full rounded-lg border py-2 pr-4 pl-10 text-sm focus:outline-none"
            />
        </div>
    );
}
