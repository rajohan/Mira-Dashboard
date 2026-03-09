import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../utils/cn";

interface SelectOption {
    value: string;
    label: string;
    description?: string;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    icon?: React.ReactNode;
    className?: string;
    width?: string;
    menuWidth?: string;
}

export function Select({
    value,
    onChange,
    options,
    placeholder = "Select...",
    icon,
    className,
    width = "min-w-[180px]",
    menuWidth,
}: SelectProps) {
    const selectedOption = options.find((opt) => opt.value === value);

    return (
        <Menu
            as="div"
            className={cn("relative inline-block", width === "w-full" && "block w-full")}
        >
            <MenuButton
                className={cn(
                    "flex items-center gap-2 rounded border border-primary-700 bg-primary-800 px-3 py-1.5 text-sm transition-colors",
                    "data-hover:border-indigo-500 data-focus:outline-none data-focus:ring-2 data-focus:ring-indigo-500",
                    width,
                    className
                )}
            >
                {icon && <span className="flex-shrink-0 text-primary-400">{icon}</span>}
                <span className="flex-1 truncate text-left">
                    {selectedOption?.label || placeholder}
                </span>
                <ChevronDown className="h-4 w-4 flex-shrink-0 text-primary-400 transition-transform data-[open]:rotate-180" />
            </MenuButton>
            <MenuItems
                anchor={{ to: "bottom start", gap: 8 }}
                className={cn(
                    "z-10 max-h-60 min-w-[var(--button-width)] max-w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded border border-primary-700 bg-primary-800 shadow-lg",
                    menuWidth || "w-max"
                )}
            >
                {options.map((option) => (
                    <MenuItem key={option.value}>
                        <button
                            onClick={() => onChange(option.value)}
                            className={cn(
                                "flex w-full flex-col px-3 py-2 text-left text-sm",
                                "data-focus:bg-primary-700",
                                value === option.value && "text-indigo-400"
                            )}
                        >
                            <span>{option.label}</span>
                            {option.description && (
                                <span className="text-xs text-primary-500">
                                    {option.description}
                                </span>
                            )}
                        </button>
                    </MenuItem>
                ))}
            </MenuItems>
        </Menu>
    );
}
