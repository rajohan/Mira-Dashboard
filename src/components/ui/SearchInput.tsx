import { Search } from "lucide-react";

interface SearchInputProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

export function SearchInput({
    value,
    onChange,
    placeholder = "Search...",
}: SearchInputProps) {
    return (
        <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-primary-400" />
            <input
                type="text"
                placeholder={placeholder}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                className="w-full rounded-lg border border-primary-600 bg-primary-700 py-2 pl-10 pr-4 text-sm text-primary-100 focus:border-accent-500 focus:outline-none"
            />
        </div>
    );
}
