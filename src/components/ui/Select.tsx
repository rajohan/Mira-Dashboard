import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../utils/cn";

/** Represents select option. */
interface SelectOption {
    value: string;
    label: string;
    description?: string;
}

/** Provides props for select. */
interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    icon?: React.ReactNode;
    ariaLabel?: string;
    className?: string;
    width?: string;
    menuWidth?: string;
}

/** Renders the select UI. */
export function Select({
    value,
    onChange,
    options,
    placeholder = "Select...",
    icon,
    ariaLabel,
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
                aria-label={ariaLabel}
                className={cn(
                    "border-primary-700 bg-primary-800 flex items-center gap-2 rounded border px-3 py-1.5 text-sm transition-colors outline-none",
                    "hover:bg-primary-700 hover:border-indigo-500 focus:outline-none data-[focus]:outline-none",
                    width,
                    className
                )}
            >
                {icon && <span className="text-primary-400 flex-shrink-0">{icon}</span>}
                <span className="flex-1 truncate text-left">
                    {selectedOption?.label || placeholder}
                </span>
                <ChevronDown className="text-primary-400 h-4 w-4 flex-shrink-0 transition-transform data-[open]:rotate-180" />
            </MenuButton>
            <MenuItems
                anchor={{ to: "bottom start", gap: 8 }}
                className={cn(
                    "border-primary-700 bg-primary-800 z-10 max-h-60 max-w-[min(36rem,calc(100vw-2rem))] min-w-[var(--button-width)] overflow-y-auto rounded border shadow-lg outline-none focus:outline-none data-[focus]:outline-none",
                    menuWidth || "w-max"
                )}
            >
                {options.map((option) => (
                    <MenuItem key={option.value}>
                        <button
                            onClick={() => onChange(option.value)}
                            className={cn(
                                "flex w-full flex-col px-3 py-2 text-left text-sm transition-colors outline-none",
                                "hover:bg-primary-700 data-[focus]:bg-primary-700 focus:outline-none data-[focus]:outline-none",
                                value === option.value && "text-indigo-400"
                            )}
                        >
                            <span>{option.label}</span>
                            {option.description && (
                                <span className="text-primary-500 text-xs">
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
