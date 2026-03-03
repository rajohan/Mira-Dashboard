import { Menu, MenuButton, MenuItem, MenuItems } from "@headlessui/react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../utils/cn";

export interface DropdownItem {
    label: string;
    onClick?: () => void;
    icon?: React.ReactNode;
    variant?: "default" | "danger";
    disabled?: boolean;
}

interface DropdownProps {
    label?: string;
    icon?: React.ReactNode;
    items: DropdownItem[];
    align?: "left" | "right";
    variant?: "primary" | "secondary" | "ghost";
    size?: "sm" | "md";
}

export function Dropdown({
    label,
    icon,
    items,
    align = "right",
    variant = "secondary",
    size = "sm",
}: DropdownProps) {
    const variantStyles = {
        primary: "bg-accent-500 text-white hover:bg-accent-600",
        secondary:
            "border border-slate-600 bg-slate-700 text-slate-100 hover:bg-slate-600",
        ghost: "text-slate-300 hover:bg-primary-700",
    };

    const sizeStyles = {
        sm: "px-2 py-1 text-sm",
        md: "px-4 py-2 text-sm",
    };

    return (
        <Menu>
            <MenuButton
                className={cn(
                    "inline-flex items-center justify-center gap-1 rounded-lg font-medium",
                    "focus:outline-none focus:ring-2 focus:ring-accent-500",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                    variantStyles[variant],
                    sizeStyles[size]
                )}
            >
                {icon}
                {label}
                {label && (
                    <ChevronDown className="data-[open]:rotate-180 h-4 w-4 transition-transform" />
                )}
            </MenuButton>

            <MenuItems
                anchor={align === "right" ? "bottom end" : "bottom start"}
                className="z-50 mt-1 min-w-[160px] origin-top-right rounded-lg border border-slate-600 bg-slate-800 p-1 shadow-lg focus:outline-none"
            >
                {items.map((item, index) => (
                    <MenuItem key={index} disabled={item.disabled}>
                        <button
                            type="button"
                            onClick={item.onClick}
                            className={cn(
                                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                                "data-focus:bg-slate-700 data-focus:text-slate-100",
                                "data-disabled:cursor-not-allowed data-disabled:opacity-50",
                                item.variant === "danger"
                                    ? "data-focus:bg-red-500/20 text-red-400"
                                    : "text-slate-300"
                            )}
                        >
                            {item.icon}
                            {item.label}
                        </button>
                    </MenuItem>
                ))}
            </MenuItems>
        </Menu>
    );
}
