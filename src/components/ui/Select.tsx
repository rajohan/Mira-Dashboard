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
interface SelectProperties {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    icon?: React.ReactNode;
    ariaLabel?: string;
    className?: string;
    width?: string;
    menuWidth?: string;
    disabled?: boolean;
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
    width = "min-w-45",
    menuWidth,
    disabled = false,
}: SelectProperties) {
    const selectedOption = options.find((opt) => opt.value === value);
    const selectedLabel = selectedOption?.label || placeholder;
    const buttonLabel = ariaLabel ? `${ariaLabel}: ${selectedLabel}` : undefined;

    return (
        <Menu
            as="div"
            className={cn("relative inline-block", width === "w-full" && "block w-full")}
        >
            <MenuButton
                aria-label={buttonLabel}
                disabled={disabled}
                className={cn(
                    "flex h-9 items-center gap-2 rounded-lg border border-primary-700 bg-primary-800 px-3 text-sm transition-colors outline-none",
                    "hover:border-accent-500 hover:bg-primary-700 focus:outline-none data-focus:border-accent-500 data-focus:outline-none",
                    width,
                    disabled && "cursor-not-allowed opacity-50",
                    className
                )}
            >
                {icon && <span className="shrink-0 text-primary-400">{icon}</span>}
                <span className="flex-1 truncate text-left">{selectedLabel}</span>
                <ChevronDown className="size-4 shrink-0 text-primary-400 transition-transform data-open:rotate-180" />
            </MenuButton>
            <MenuItems
                anchor={{ to: "bottom start", gap: 8 }}
                className={cn(
                    "z-10 max-h-60 max-w-[min(36rem,calc(100vw-2rem))] min-w-(--button-width) overflow-y-auto rounded-lg border border-primary-700 bg-primary-900 shadow-xl ring-1 shadow-black/30 ring-black/20 outline-none focus:outline-none data-focus:outline-none",
                    menuWidth || "w-max"
                )}
            >
                {options.map((option) => (
                    <MenuItem key={option.value}>
                        <button
                            onClick={() => onChange(option.value)}
                            className={cn(
                                "flex w-full flex-col px-3 py-2 text-left text-sm transition-colors outline-none",
                                "hover:bg-primary-700 focus:outline-none data-focus:bg-primary-700 data-focus:outline-none",
                                value === option.value &&
                                    "bg-accent-500/10 text-accent-300"
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
